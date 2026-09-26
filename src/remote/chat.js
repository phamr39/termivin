// Chat store for the phone's chat view. Conversations:
//   dm:<termId>    the owner ⇄ one terminal (owner messages, the agent's
//                  replies from its transcript, bus mail addressed to owner)
//   ws:<spaceId>   a workspace group: owner broadcasts + agent↔agent traffic
// One append-only .jsonl per conversation under <userData>/remote/chat, plus
// read markers in state.json. Messages are deduplicated by id.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HISTORY_READ_BYTES = 2 * 1024 * 1024;
const SEEN_MAX = 5000;

function safeName(conv) {
  return conv.replace(/[^A-Za-z0-9_.:-]/g, '_').replace(/:/g, '__');
}

class ChatStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.seen = new Map(); // conv -> Set(ids)
    this.last = new Map(); // conv -> last message
    this.readAt = {}; // conv -> ts
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.readAt = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).readAt || {};
    } catch {}
  }

  file(conv) {
    return path.join(this.dir, safeName(conv) + '.jsonl');
  }

  seenSet(conv) {
    let set = this.seen.get(conv);
    if (!set) {
      set = new Set();
      for (const m of this.read(conv, 1000)) set.add(m.id);
      this.seen.set(conv, set);
    }
    return set;
  }

  read(conv, limit = 200, before = Infinity) {
    const file = this.file(conv);
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - HISTORY_READ_BYTES);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
        if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.ts < before) out.push(m);
      } catch {}
    }
    // Later records for the same id (e.g. queued → delivered) win.
    const byId = new Map();
    for (const m of out) byId.set(m.id, { ...(byId.get(m.id) || {}), ...m });
    return [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-limit);
  }

  // msg: { id, ts, from, fromName, role, kind, text, ...extra }
  add(conv, msg) {
    const set = this.seenSet(conv);
    if (set.has(msg.id)) return false;
    set.add(msg.id);
    if (set.size > SEEN_MAX) this.seen.set(conv, new Set([...set].slice(-SEEN_MAX / 2)));
    const full = { ts: Date.now(), ...msg, conv };
    fs.appendFileSync(this.file(conv), JSON.stringify(full) + '\n');
    this.last.set(conv, full);
    this.emit('message', conv, full);
    return true;
  }

  // Update fields of an existing message (e.g. a queued prompt got delivered).
  update(conv, id, patch) {
    const full = { id, ts: Date.now(), ...patch, conv, update: true };
    fs.appendFileSync(this.file(conv), JSON.stringify(full) + '\n');
    this.emit('update', conv, full);
  }

  history(conv, { before, limit = 50 } = {}) {
    return this.read(conv, Math.min(200, limit), Number.isFinite(before) ? before : Infinity);
  }

  lastMessage(conv) {
    if (!this.last.has(conv)) {
      const m = this.read(conv, 1)[0] || null;
      this.last.set(conv, m);
    }
    return this.last.get(conv);
  }

  markRead(conv, ts) {
    this.readAt[conv] = Math.max(this.readAt[conv] || 0, Number(ts) || Date.now());
    try {
      fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify({ readAt: this.readAt }));
    } catch {}
  }

  unread(conv) {
    const since = this.readAt[conv] || 0;
    return this.read(conv, 200).filter((m) => m.ts > since && m.role !== 'owner').length;
  }
}

module.exports = { ChatStore };
