// Turns → chat summaries. The phone's chat shows one message per unit of
// work, not every step: while an agent works the phone sees a live progress
// line (not stored), and when the turn ends a single summary lands in the DM —
// the agent's final reply (headline + full text on demand), what it did
// (edits, commands, …, as a collapsible list) and how long it took.
//
// Claude Code: turns come from its transcript (a typed prompt opens one,
// system/turn_duration closes it; end_turn + quiet is the fallback).
// Other terminals (Codex, custom agents, shells): a prompt sent from the phone
// opens a turn, the terminal going idle closes it, and the summary is the tail
// of what it printed.

const MAX_STEPS = 60;
const HEADLINE_MAX = 240;
const BACKFILL_TURNS = 3;
const QUIET_END_MS = 6000; // end_turn seen and nothing since → turn is over

// First sentence(s) of a reply, stripped of markdown, for the collapsed card.
function headline(text) {
  const para = String(text || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^```/.test(p)) || '';
  const plain = para
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= HEADLINE_MAX) return plain;
  const cut = plain.slice(0, HEADLINE_MAX);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '')) + '…';
}

function newTurn(id, ts, prompt) {
  return {
    id, startedAt: ts, lastAt: ts, prompt: prompt || '', texts: [], steps: [],
    counts: { edit: 0, command: 0, read: 0, other: 0 }, endHint: false,
  };
}

class TurnTracker {
  // sink: { post(termId, msg, { notify }), prompt(termId, event), progress(termId, info|null) }
  constructor(sink) {
    this.sink = sink;
    this.turns = new Map(); // termId -> open turn
    this.titles = new Map(); // termId -> session title
  }

  // Events from the transcript watcher, in order.
  onEvents(termId, events, { backfill = false } = {}) {
    if (backfill) return this.backfill(termId, events);
    for (const e of events) this.apply(termId, e, true);
    const t = this.turns.get(termId);
    if (t) this.sink.progress(termId, this.progressOf(t));
  }

  apply(termId, e, live) {
    if (e.type === 'title') {
      this.titles.set(termId, e.text);
      return;
    }
    let t = this.turns.get(termId);
    if (e.type === 'user') {
      if (t) this.finish(termId, { live, interrupted: true });
      t = newTurn('turn:' + e.id, e.ts, e.text);
      this.turns.set(termId, t);
      if (live) this.sink.prompt(termId, e);
      return;
    }
    if (!t) {
      // Work without a prompt we saw (e.g. the file was bound mid-turn).
      if (e.type === 'end' || e.type === 'endHint') return;
      t = newTurn('turn:' + e.id, e.ts, '');
      this.turns.set(termId, t);
    }
    t.lastAt = e.ts;
    if (e.type === 'text') {
      t.texts.push(e.text);
      t.endHint = false;
    } else if (e.type === 'tool') {
      t.steps.push(e.text);
      if (t.steps.length > MAX_STEPS) t.steps.splice(0, t.steps.length - MAX_STEPS);
      t.counts[e.category || 'other']++;
      t.endHint = false;
    } else if (e.type === 'endHint') {
      t.endHint = true;
    } else if (e.type === 'end') {
      this.finish(termId, { live, durationMs: e.durationMs, endedAt: e.ts });
    }
  }

  // On (re)binding a transcript: summarize only the last few finished turns,
  // silently, and keep a trailing unfinished one open.
  backfill(termId, events) {
    const finished = [];
    const saved = this.sink.post;
    this.sink.post = (tid, msg) => finished.push(msg);
    try {
      for (const e of events) this.apply(termId, e, false);
    } finally {
      this.sink.post = saved;
    }
    for (const msg of finished.slice(-BACKFILL_TURNS)) this.sink.post(termId, msg, { notify: false });
  }

  // Called periodically: close turns whose end marker never came.
  tick(termId, { idle }) {
    const t = this.turns.get(termId);
    if (t && t.endHint && idle && Date.now() - t.lastAt > QUIET_END_MS) this.finish(termId, { live: true });
  }

  finish(termId, { live, durationMs = null, endedAt = null, interrupted = false }) {
    const t = this.turns.get(termId);
    if (!t) return;
    this.turns.delete(termId);
    if (live) this.sink.progress(termId, null);
    if (!t.texts.length && !t.steps.length) return;
    const final = t.texts[t.texts.length - 1] || '';
    const n = t.steps.length;
    const text = final || (interrupted ? `Stopped after ${n} step${n === 1 ? '' : 's'}.` : `Done — ${n} step${n === 1 ? '' : 's'}.`);
    this.sink.post(termId, {
      id: t.id,
      ts: endedAt || t.lastAt,
      kind: 'summary',
      role: 'agent',
      text,
      headline: headline(text),
      prompt: t.prompt.slice(0, 300),
      steps: t.steps,
      stats: { ...t.counts, durationMs: durationMs || Math.max(0, (endedAt || t.lastAt) - t.startedAt) },
      interrupted,
    }, { notify: live });
  }

  progressOf(t) {
    return {
      startedAt: t.startedAt,
      steps: t.steps.length,
      last: t.steps[t.steps.length - 1] || (t.texts.length ? headline(t.texts[t.texts.length - 1]) : ''),
    };
  }

  isOpen(termId) {
    return this.turns.has(termId);
  }

  title(termId) {
    return this.titles.get(termId) || null;
  }
}

// ANSI/OSC codes out, carriage-return overwrites resolved — plain lines.
function plainLines(output) {
  return String(output || '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop().replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd());
}

// Summary for a non-transcript terminal: the last lines it printed after the
// prompt, minus the echoed command and the shell prompt it came back to.
// `output` is either rendered lines (preferred, from the hub's screen) or raw
// terminal output.
function screenSummary(output, sentText) {
  const lines = (Array.isArray(output) ? output : plainLines(output)).filter((l) => l.trim());
  const sent = String(sentText || '').trim();
  const body = lines.filter((l, i) => !(i === 0 && sent && l.includes(sent.slice(0, 40))));
  while (body.length && /^(PS [A-Z]:\\.*>|[\w.-]+@[\w.-]+.*[$#%]|[$#>❯])\s*$/.test(body[body.length - 1].trim())) body.pop();
  return body.slice(-12).join('\n');
}

module.exports = { TurnTracker, headline, screenSummary, plainLines };
