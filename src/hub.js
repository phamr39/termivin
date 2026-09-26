// Session hub: the main process's own view of every running PTY, independent
// of the renderer. Each session keeps a headless xterm (the real screen, so a
// phone can be shown exactly what is there), a sequence-numbered ring buffer
// of raw output (so a reconnecting viewer only gets what it missed), and the
// derived state a remote needs: working/idle, a pending approval with the hash
// of its prompt, and a one-line summary of what the terminal is doing.
//
// The renderer still renders and still runs its own detection for the desktop
// UI; both use src/shared/approval.js so they agree.

const { EventEmitter } = require('events');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const IDLE_AFTER_MS = 3000;
const CHECK_DEBOUNCE_MS = 700;
const CHECK_MAX_WAIT_MS = 2500;
const RING_BYTES = 512 * 1024;
const SCROLLBACK = 2000;

let shared = null; // src/shared/approval.js (ESM), loaded once at startup
const sharedReady = import('./shared/approval.js').then((m) => { shared = m; });

class Session {
  constructor(id, { cols, rows, pid }) {
    this.id = id;
    this.pid = pid;
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.seq = 0; // bytes of output seen so far (as UTF-16 code units of the chunks)
    this.ring = []; // [{ seq (start), data }]
    this.ringSize = 0;
    this.startedAt = Date.now();
    this.lastDataAt = Date.now();
    this.running = true;
    this.exitCode = null;
    this.approval = null;
    this.answeredHash = null;
    this.summary = '';
    this.checkTimer = null;
    this.checkDeadline = 0;
    this.idleTimer = null;
    this.status = 'working';
  }

  tail(n) {
    const buf = this.term.buffer.active;
    // Only the region around the viewport — scanning all scrollback on every
    // check would be wasted work in the main process.
    const end = buf.baseY + this.term.rows;
    const lines = [];
    for (let i = Math.max(0, end - Math.max(n, this.term.rows) - 10); i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
    }
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.slice(-n);
  }
}

class Hub extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.ready = sharedReady;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  // A PTY started (or restarted) under this id.
  start(id, { cols, rows, pid }) {
    this.stop(id, { silent: true });
    const s = new Session(id, { cols, rows, pid });
    this.sessions.set(id, s);
    this.emit('status', id);
    return s;
  }

  data(id, data) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.term.write(data);
    const start = s.seq;
    s.seq += data.length;
    s.ring.push({ seq: start, data });
    s.ringSize += data.length;
    while (s.ringSize > RING_BYTES && s.ring.length > 1) s.ringSize -= s.ring.shift().data.length;
    this.emit('data', id, start, data);

    const now = Date.now();
    s.lastDataAt = now;
    if (s.status !== 'working' && s.status !== 'approval') this.setStatus(s, 'working');
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.refresh(s), IDLE_AFTER_MS);
    if (!s.checkTimer) s.checkDeadline = now + CHECK_MAX_WAIT_MS;
    clearTimeout(s.checkTimer);
    s.checkTimer = setTimeout(() => {
      s.checkTimer = null;
      this.check(s);
    }, Math.max(0, Math.min(CHECK_DEBOUNCE_MS, s.checkDeadline - now)));
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && cols > 0 && rows > 0) {
      try { s.term.resize(cols, rows); } catch {}
    }
  }

  exit(id, code) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.running = false;
    s.exitCode = code;
    s.approval = null;
    clearTimeout(s.checkTimer);
    clearTimeout(s.idleTimer);
    this.setStatus(s, 'exited');
    this.emit('attention');
  }

  // Killed on purpose (stop / restart / close): forget it quietly.
  stop(id, { silent = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.checkTimer);
    clearTimeout(s.idleTimer);
    try { s.term.dispose(); } catch {}
    this.sessions.delete(id);
    if (!silent) {
      this.emit('status', id);
      this.emit('attention');
    }
  }

  check(s) {
    if (!shared || !s.running) return;
    const lines = s.tail(40);
    s.summary = shared.summarize(lines) || s.summary;
    const found = shared.detectApproval(lines.slice(-30));
    if (!found) {
      s.answeredHash = null;
      if (s.approval) {
        s.approval = null;
        this.emit('attention');
      }
    } else if (found.hash !== s.answeredHash && (!s.approval || s.approval.hash !== found.hash)) {
      s.approval = { ...found, id: `${s.id}:${found.hash}`, since: Date.now() };
      this.emit('attention');
      this.emit('approval', s.id, s.approval);
    }
    this.refresh(s);
  }

  refresh(s) {
    if (!s.running) return;
    const quiet = Date.now() - s.lastDataAt >= IDLE_AFTER_MS - 50;
    this.setStatus(s, s.approval ? 'approval' : quiet ? 'idle' : 'working');
  }

  setStatus(s, status) {
    if (s.status === status) return;
    s.status = status;
    this.emit('status', s.id);
  }

  status(id) {
    const s = this.sessions.get(id);
    return s ? s.status : null;
  }

  // The screen as ANSI, for a viewer that just subscribed.
  screen(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return {
      seq: s.seq,
      cols: s.term.cols,
      rows: s.term.rows,
      data: s.serializer.serialize({ scrollback: 300 }),
    };
  }

  // Output since `seq`, or null when it has already left the ring buffer.
  since(id, seq) {
    const s = this.sessions.get(id);
    if (!s || !Number.isInteger(seq) || seq > s.seq) return null;
    if (seq === s.seq) return '';
    const first = s.ring[0];
    if (!first || seq < first.seq) return null;
    let out = '';
    for (const chunk of s.ring) {
      const end = chunk.seq + chunk.data.length;
      if (end <= seq) continue;
      out += chunk.seq >= seq ? chunk.data : chunk.data.slice(seq - chunk.seq);
    }
    return out;
  }

  // Answer a prompt from a remote. The keys go out only if the very prompt the
  // phone showed is still the one on screen.
  answer(id, { approvalId, screenHash, option }) {
    const s = this.sessions.get(id);
    if (!s || !s.running) return { ok: false, error: 'not_running' };
    // Re-read the screen now rather than trusting the last debounced check.
    const current = shared.detectApproval(s.tail(30));
    if (!current) return { ok: false, error: 'no_prompt' };
    if (current.hash !== screenHash || (approvalId && approvalId !== `${id}:${current.hash}`)) {
      return { ok: false, error: 'prompt_changed' };
    }
    const keys = shared.optionKeys(current, String(option));
    if (!keys) return { ok: false, error: 'bad_option' };
    s.answeredHash = current.hash;
    s.approval = null;
    this.emit('attention');
    this.refresh(s);
    return { ok: true, keys };
  }

  // Everything that needs a human, across sessions (the phone's inbox).
  attention(describe) {
    const items = [];
    for (const s of this.sessions.values()) {
      const who = describe(s.id);
      if (!who) continue;
      if (s.approval) {
        items.push({
          id: s.approval.id, kind: 'approval', termId: s.id, spaceId: who.spaceId,
          title: who.name, excerpt: s.approval.excerpt || '', question: s.approval.question || '',
          options: s.approval.options, promptKind: s.approval.kind,
          screenHash: s.approval.hash, since: s.approval.since,
        });
      } else if (!s.running && s.exitCode !== 0 && s.exitCode != null) {
        items.push({
          id: `${s.id}:exit:${s.startedAt}`, kind: 'exited', termId: s.id, spaceId: who.spaceId,
          title: who.name, excerpt: `exit code ${s.exitCode}`, since: s.lastDataAt,
        });
      }
    }
    return items.sort((a, b) => a.since - b.since);
  }
}

module.exports = { Hub };
