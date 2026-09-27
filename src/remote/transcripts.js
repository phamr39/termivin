// Reads Claude Code's own session transcripts (~/.claude/projects/<slug>/
// <session>.jsonl) so the chat view can show what an agent said, not just raw
// terminal output. Files are append-only: each bound file keeps a byte offset
// and only new lines are parsed.
//
// Binding a terminal to its transcript: the newest .jsonl in the project
// folder for the terminal's cwd that was written after the terminal started
// and is not already bound to another running terminal. `--continue` keeps
// writing into (or forks from) the newest session, which this follows.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_READ = 4 * 1024 * 1024;
const BACKFILL = 300; // events — the turn tracker keeps only the last few turns of them

function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code names a project folder after its cwd with every
// non-alphanumeric character replaced by '-'.
function projectSlug(cwd) {
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

function toolSummary(item) {
  const input = item.input || {};
  const short = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  switch (item.name) {
    case 'Bash': return `▶ ${short(input.command)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write': return `✎ ${item.name} ${short(input.file_path)}`;
    case 'Read': return `📄 Read ${short(input.file_path)}`;
    case 'Grep': return `🔎 Grep ${short(input.pattern)}`;
    case 'Glob': return `🔎 Glob ${short(input.pattern)}`;
    case 'WebFetch': return `🌐 ${short(input.url)}`;
    case 'Task':
    case 'Agent': return `🤖 ${short(input.description || input.prompt)}`;
    case 'TodoWrite': return '☑ updated the todo list';
    default: return `⚙ ${item.name}`;
  }
}

// What kind of step a tool call is, for the turn summary's counters.
function toolCategory(name) {
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Bash|PowerShell|BashOutput|KillShell)$/.test(name)) return 'command';
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/.test(name)) return 'read';
  return 'other';
}

// One transcript line → zero or more events:
//   user  a prompt a person typed
//   text  a piece of the agent's reply
//   tool  a tool call (one-line summary + category)
//   end   the turn finished (system/turn_duration, with its duration);
//         'endHint' is the weaker end_turn stop reason, for older versions
//   title Claude Code's generated session title
function parseEntry(entry) {
  if (!entry) return [];
  const ts = Date.parse(entry.timestamp) || Date.now();
  const base = entry.uuid || `${ts}`;
  if (entry.type === 'ai-title' && entry.aiTitle) return [{ type: 'title', text: String(entry.aiTitle).slice(0, 120) }];
  if (entry.isSidechain || entry.isMeta) return [];
  if (entry.type === 'system' && entry.subtype === 'turn_duration') {
    return [{ type: 'end', id: `tx:${base}`, ts, durationMs: Number(entry.durationMs) || null }];
  }
  if (entry.type === 'user' && entry.message) {
    // Only prompts a person typed — not tool results, hooks or slash-command
    // plumbing, which also arrive as "user" entries.
    const typed = entry.origin ? entry.origin.kind === 'human' : typeof entry.message.content === 'string';
    if (!typed) return [];
    const text = textOf(entry.message.content).trim();
    if (!text || /^<(command-|local-command|system-reminder|bash-)/.test(text)) return [];
    return [{ type: 'user', id: `tx:${base}`, ts, text: text.slice(0, 8000) }];
  }
  if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
    const out = [];
    entry.message.content.forEach((c, i) => {
      if (c.type === 'text' && c.text && c.text.trim()) {
        out.push({ type: 'text', id: `tx:${base}:${i}`, ts, text: c.text.trim().slice(0, 12000) });
      } else if (c.type === 'tool_use') {
        out.push({ type: 'tool', id: `tx:${base}:${i}`, ts, text: toolSummary(c), category: toolCategory(c.name) });
      }
    });
    if (entry.message.stop_reason === 'end_turn') out.push({ type: 'endHint', id: `tx:${base}:end`, ts });
    return out;
  }
  return [];
}

function readLines(file, from) {
  const size = fs.statSync(file).size;
  if (size <= from) return { lines: [], offset: size < from ? 0 : from };
  const start = Math.max(from, size - MAX_READ);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Keep an unfinished last line for the next read.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { lines: [], offset: start };
    const lines = text.slice(0, lastNl).split('\n');
    if (start > from) lines.shift(); // started mid-line after a big jump
    return { lines, offset: start + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } finally {
    fs.closeSync(fd);
  }
}

class TranscriptWatcher {
  constructor(onMessages) {
    this.onMessages = onMessages; // (termId, events[], { backfill }) => void
    this.bound = new Map(); // termId -> { file, offset }
  }

  // terms: [{ termId, cwd, startedAt }] — running Claude Code terminals.
  poll(terms) {
    const live = new Set(terms.map((t) => t.termId));
    for (const id of this.bound.keys()) if (!live.has(id)) this.bound.delete(id);
    for (const t of terms) {
      try {
        this.pollOne(t);
      } catch {}
    }
  }

  pollOne({ termId, cwd, startedAt }) {
    const dir = path.join(projectsDir(), projectSlug(cwd));
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const file = path.join(dir, f);
          return { file, mtime: fs.statSync(file).mtimeMs };
        });
    } catch {
      return;
    }
    const takenByOthers = new Set([...this.bound.entries()].filter(([id]) => id !== termId).map(([, b]) => b.file));
    const candidate = files
      .filter((f) => f.mtime >= startedAt - 5000 && !takenByOthers.has(f.file))
      .sort((a, b) => b.mtime - a.mtime)[0];
    let b = this.bound.get(termId);
    if (candidate && (!b || (b.file !== candidate.file && candidate.mtime > b.mtime + 2000))) {
      // New binding (or the session moved to a newer file, e.g. /clear):
      // backfill the last few messages, then follow.
      const { lines, offset } = readLines(candidate.file, 0);
      const events = lines.slice(-600).flatMap((l) => {
        try { return parseEntry(JSON.parse(l)); } catch { return []; }
      });
      b = { file: candidate.file, offset, mtime: candidate.mtime };
      this.bound.set(termId, b);
      if (events.length) this.onMessages(termId, events.slice(-BACKFILL), { backfill: true });
      return;
    }
    if (!b) return;
    const { lines, offset } = readLines(b.file, b.offset);
    b.offset = offset;
    if (candidate && candidate.file === b.file) b.mtime = candidate.mtime;
    const msgs = lines.flatMap((l) => {
      try { return parseEntry(JSON.parse(l)); } catch { return []; }
    });
    if (msgs.length) this.onMessages(termId, msgs, { backfill: false });
  }
}

module.exports = { TranscriptWatcher, parseEntry, projectSlug };
