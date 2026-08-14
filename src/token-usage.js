// Token usage for the dashboards, read from the CLIs' own transcripts:
//   Claude Code — ~/.claude/projects/<slug>/<session>.jsonl
//     assistant lines carry message.usage {input_tokens, output_tokens,
//     cache_creation_input_tokens, cache_read_input_tokens} and a cwd.
//   Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//     token_count events carry payload.info.total_token_usage (cumulative per
//     session — the last one wins); session_meta carries the cwd.
//
// Files are append-only, so each file keeps a byte offset and is only read
// from where the previous scan stopped. Results cache for CACHE_MS.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_MS = 20000;
const MAX_LINE = 4 * 1024 * 1024;

let cache = null;
let cacheAt = 0;

// path -> { offset, remainder } — persistent incremental-read positions
const filePos = new Map();
// per-day dedup of claude messages (messageId:requestId)
let seenClaude = new Set();
let seenDay = '';
// path -> accumulated claude totals for lines already read
const claudeFileTotals = new Map(); // path -> { perCwd: Map, today: {...}, day }
// path -> { total_token_usage, cwd } for codex files
const codexFileTotals = new Map();

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normCwd(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function zeroTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, messages: 0 };
}

// Read the yet-unread tail of a file, returning whole lines.
function readNewLines(file, size) {
  const pos = filePos.get(file) || { offset: 0, remainder: '' };
  if (size < pos.offset) {
    // truncated/rewritten — start over
    pos.offset = 0;
    pos.remainder = '';
  }
  if (size === pos.offset) return [];
  const fd = fs.openSync(file, 'r');
  let chunkText;
  try {
    const len = size - pos.offset;
    const buf = Buffer.alloc(Math.min(len, 64 * 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, pos.offset);
    pos.offset += n;
    chunkText = pos.remainder + buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
  const lines = chunkText.split('\n');
  pos.remainder = lines.pop() || '';
  if (pos.remainder.length > MAX_LINE) pos.remainder = ''; // corrupt/huge line — drop
  filePos.set(file, pos);
  return lines;
}

// --- Claude ---------------------------------------------------------------

function scanClaude(today) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const out = { today: zeroTotals(), byCwd: new Map() };
  let dirs;
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return out;
  }
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let acc = claudeFileTotals.get(file);
      if (!acc || acc.day !== today) {
        acc = { day: today, today: zeroTotals(), perCwd: new Map() };
        claudeFileTotals.set(file, acc);
        // a new day starts counting from the top of the file again? No — the
        // offset already points past yesterday's lines; only new lines count.
      }
      // Skip files that haven't grown and were last touched before today.
      const pos = filePos.get(file);
      if (pos && pos.offset >= st.size) {
        // nothing new
      } else if (!pos && st.mtimeMs < dayStart.getTime()) {
        // never-read file that predates today — none of it counts for today,
        // so just mark it fully read without parsing.
        filePos.set(file, { offset: st.size, remainder: '' });
      } else {
        for (const line of readNewLines(file, st.size)) {
          if (line.length < 20 || line.indexOf('"usage"') === -1) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          const usage = obj && obj.message && obj.message.usage;
          if (!usage || obj.type !== 'assistant') continue;
          const ts = obj.timestamp ? new Date(obj.timestamp) : null;
          if (!ts || dayKey(ts) !== today) continue;
          const key = (obj.message.id || '') + ':' + (obj.requestId || '');
          if (key !== ':' && seenClaude.has(key)) continue;
          if (key !== ':') seenClaude.add(key);
          const inTok = usage.input_tokens || 0;
          const outTok = usage.output_tokens || 0;
          const cr = usage.cache_read_input_tokens || 0;
          const cc = usage.cache_creation_input_tokens || 0;
          acc.today.input += inTok;
          acc.today.output += outTok;
          acc.today.cacheRead += cr;
          acc.today.cacheCreate += cc;
          acc.today.total += inTok + outTok + cr + cc;
          acc.today.messages++;
          const cwd = normCwd(obj.cwd);
          if (cwd) {
            const c = acc.perCwd.get(cwd) || zeroTotals();
            c.input += inTok;
            c.output += outTok;
            c.cacheRead += cr;
            c.cacheCreate += cc;
            c.total += inTok + outTok + cr + cc;
            c.messages++;
            acc.perCwd.set(cwd, c);
          }
        }
      }
      // fold this file's accumulated today-totals into the result
      const t = acc.today;
      out.today.input += t.input;
      out.today.output += t.output;
      out.today.cacheRead += t.cacheRead;
      out.today.cacheCreate += t.cacheCreate;
      out.today.total += t.total;
      out.today.messages += t.messages;
      for (const [cwd, c] of acc.perCwd) {
        const g = out.byCwd.get(cwd) || zeroTotals();
        g.input += c.input;
        g.output += c.output;
        g.cacheRead += c.cacheRead;
        g.cacheCreate += c.cacheCreate;
        g.total += c.total;
        g.messages += c.messages;
        out.byCwd.set(cwd, g);
      }
    }
  }
  return out;
}

// --- Codex ----------------------------------------------------------------

function scanCodex(today) {
  const [y, m, d] = today.split('-');
  const dir = path.join(os.homedir(), '.codex', 'sessions', y, m, d);
  const out = { today: zeroTotals(), byCwd: new Map() };
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const f of files) {
    const file = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    let acc = codexFileTotals.get(file);
    if (!acc) {
      acc = { cwd: null, usage: null };
      codexFileTotals.set(file, acc);
    }
    for (const line of readNewLines(file, st.size)) {
      if (line.indexOf('"session_meta"') !== -1 && !acc.cwd) {
        try {
          const obj = JSON.parse(line);
          acc.cwd = normCwd(obj.payload && obj.payload.cwd);
        } catch {}
      } else if (line.indexOf('"total_token_usage"') !== -1) {
        try {
          const obj = JSON.parse(line);
          const u = obj.payload && obj.payload.info && obj.payload.info.total_token_usage;
          if (u) acc.usage = u; // cumulative — last one wins
        } catch {}
      }
    }
    if (acc.usage) {
      const inTok = acc.usage.input_tokens || 0;
      const outTok = acc.usage.output_tokens || 0;
      const cached = acc.usage.cached_input_tokens || 0;
      out.today.input += Math.max(0, inTok - cached);
      out.today.cacheRead += cached;
      out.today.output += outTok;
      out.today.total += inTok + outTok;
      out.today.messages++;
      if (acc.cwd) {
        const c = out.byCwd.get(acc.cwd) || zeroTotals();
        c.input += Math.max(0, inTok - cached);
        c.cacheRead += cached;
        c.output += outTok;
        c.total += inTok + outTok;
        out.byCwd.set(acc.cwd, c);
      }
    }
  }
  return out;
}

// --- public ----------------------------------------------------------------

function usage() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  const today = dayKey();
  if (seenDay !== today) {
    seenDay = today;
    seenClaude = new Set();
  }
  let claude = { today: zeroTotals(), byCwd: new Map() };
  let codex = { today: zeroTotals(), byCwd: new Map() };
  try {
    claude = scanClaude(today);
  } catch (err) {
    console.error('[usage] claude scan failed:', err.message);
  }
  try {
    codex = scanCodex(today);
  } catch (err) {
    console.error('[usage] codex scan failed:', err.message);
  }
  cache = {
    day: today,
    claude: { today: claude.today, byCwd: Object.fromEntries(claude.byCwd) },
    codex: { today: codex.today, byCwd: Object.fromEntries(codex.byCwd) },
    updatedAt: now,
  };
  cacheAt = now;
  return cache;
}

module.exports = { usage };
