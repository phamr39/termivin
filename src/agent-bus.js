// Agent bus: a loopback HTTP server that lets the AI agents running in one
// workspace discover each other and exchange messages. Design notes and the
// security rationale live in docs/AGENT-BUS.md.
//
// Agents have no event loop, so there is no real subscribe: delivery is a
// long-poll (`GET /recv?wait=N`) that blocks inside the agent's shell tool.
// Everything else is a plain request/response.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_WAIT_MS = 60000; // cap: Claude Code kills bash calls at ~2 minutes
const RATE_LIMIT = 20; // messages per agent per minute
const RATE_WINDOW_MS = 60000;
const DEFAULT_TTL = 3;

let server = null;
let token = null;
let url = null;
let dataDir = null;
let onEvent = () => {};

// termId -> { role, skills, cwd, registeredAt }
const profiles = new Map();
// termId -> Message[] awaiting delivery
const pending = new Map();
// termId -> { resolve, timer }
const waiters = new Map();
// termId -> { count, resetAt }
const rate = new Map();
// Live view of the renderer's state: termId -> { termId, spaceId, spaceName,
// name, type, status }. Pushed on every render/status change.
let roster = new Map();

// --- topics ---------------------------------------------------------------
// A topic belongs to one workspace. Inside that workspace, a message to the
// topic is a broadcast every agent hears; from any OTHER workspace it is
// delivered to the topic's representative agent only — the one terminal that
// speaks for the workspace to the outside. Persisted in <dataDir>/topics.json.
// topicId -> { id, name, spaceId, repId, createdAt }
const topics = new Map();

// --- traffic stats (drive the dashboard maps; reset on app start) ----------
const linkCounts = new Map(); // 'fromId>toId' -> count
const agentTraffic = new Map(); // termId -> { sent, recv }
const spaceLinks = new Map(); // 'fromSpaceId>toSpaceId' -> count (cross-space only)
const recentMessages = []; // ring buffer of the last RECENT_MAX deliveries
const RECENT_MAX = 200;

function bumpTraffic(fromId, toId, fromSpace, toSpace) {
  const key = fromId + '>' + toId;
  linkCounts.set(key, (linkCounts.get(key) || 0) + 1);
  const f = agentTraffic.get(fromId) || { sent: 0, recv: 0 };
  f.sent++;
  agentTraffic.set(fromId, f);
  const t = agentTraffic.get(toId) || { sent: 0, recv: 0 };
  t.recv++;
  agentTraffic.set(toId, t);
  if (fromSpace && toSpace && fromSpace !== toSpace) {
    const sk = fromSpace + '>' + toSpace;
    spaceLinks.set(sk, (spaceLinks.get(sk) || 0) + 1);
  }
}

function topicsFile() {
  return path.join(dataDir, 'topics.json');
}

function saveTopics() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(topicsFile(), JSON.stringify([...topics.values()], null, 2), 'utf8');
  } catch (err) {
    console.error('[bus] topics save failed:', err.message);
  }
}

function loadTopics() {
  try {
    for (const t of JSON.parse(fs.readFileSync(topicsFile(), 'utf8'))) {
      if (t && t.id && t.name && t.spaceId) topics.set(t.id, t);
    }
  } catch {}
}

function findTopicByName(name) {
  const needle = String(name).toLowerCase();
  return [...topics.values()].find((t) => t.name.toLowerCase() === needle) || null;
}

function agentsInSpace(spaceId) {
  return [...roster.values()].filter((a) => a.spaceId === spaceId);
}

// The terminal that answers for a topic when another workspace calls: the
// configured representative if it still exists, else a registered agent in
// the topic's workspace, else any agent there.
function topicRepresentative(topic) {
  if (topic.repId && roster.has(topic.repId)) return roster.get(topic.repId);
  const candidates = agentsInSpace(topic.spaceId);
  return candidates.find((a) => profiles.has(a.termId)) || candidates[0] || null;
}

function createTopic(name, spaceId, repId) {
  const clean = String(name || '').trim().replace(/^#/, '').slice(0, 60);
  if (!clean) return { ok: false, error: 'topic name required' };
  const existing = findTopicByName(clean);
  if (existing) {
    return { ok: false, error: `topic "${clean}" already exists`, topic: existing };
  }
  const topic = {
    id: 'tp_' + crypto.randomBytes(5).toString('hex'),
    name: clean,
    spaceId,
    repId: repId || null,
    createdAt: Date.now(),
  };
  topics.set(topic.id, topic);
  saveTopics();
  onEvent({ type: 'topic', op: 'create', topic });
  return { ok: true, topic };
}

function updateTopic(id, patch) {
  const topic = topics.get(id);
  if (!topic) return { ok: false, error: 'no such topic' };
  if (patch.name) {
    const clean = String(patch.name).trim().replace(/^#/, '').slice(0, 60);
    const other = findTopicByName(clean);
    if (other && other.id !== id) return { ok: false, error: `topic "${clean}" already exists` };
    if (clean) topic.name = clean;
  }
  if ('repId' in patch) topic.repId = patch.repId || null;
  saveTopics();
  onEvent({ type: 'topic', op: 'update', topic });
  return { ok: true, topic };
}

function deleteTopic(id) {
  const topic = topics.get(id);
  if (!topic) return { ok: false, error: 'no such topic' };
  topics.delete(id);
  saveTopics();
  onEvent({ type: 'topic', op: 'delete', topic });
  return { ok: true };
}

function queueFor(id) {
  if (!pending.has(id)) pending.set(id, []);
  return pending.get(id);
}

// --- persistence ----------------------------------------------------------
// One append-only log per workspace. Records are {t:'msg'|'deliver'}; the
// pending queues are rebuilt by replaying the log at startup, so messages
// nobody picked up survive an app restart.

function logFile(spaceId) {
  return path.join(dataDir, `${String(spaceId).replace(/[^\w.-]/g, '_')}.jsonl`);
}

function append(spaceId, record) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logFile(spaceId), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[bus] log write failed:', err.message);
  }
}

function replayLogs() {
  let files;
  try {
    files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(dataDir, f), 'utf8').split('\n');
    } catch {
      continue;
    }
    const undelivered = new Map(); // messageId -> {to, msg}
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.t === 'msg') undelivered.set(rec.msg.id + '>' + rec.to, rec);
      else if (rec.t === 'deliver') undelivered.delete(rec.id + '>' + rec.to);
    }
    for (const rec of undelivered.values()) queueFor(rec.to).push(rec.msg);
  }
}

// --- delivery -------------------------------------------------------------

function deliver(toId, msg, spaceId) {
  append(spaceId, { t: 'msg', to: toId, msg });
  const fromSpace = roster.get(msg.from) ? roster.get(msg.from).spaceId : null;
  bumpTraffic(msg.from, toId, fromSpace, spaceId);
  recentMessages.push({
    ts: msg.ts,
    from: msg.from,
    fromName: msg.fromName,
    fromSpace,
    to: toId,
    toName: msg.toName,
    toSpace: spaceId,
    kind: msg.kind,
    subject: msg.subject,
    topic: msg.topic || null,
    broadcast: !!msg.broadcast,
  });
  if (recentMessages.length > RECENT_MAX) recentMessages.splice(0, recentMessages.length - RECENT_MAX);
  onEvent({
    type: 'msg', from: msg.from, to: toId, fromSpace, toSpace: spaceId,
    topic: msg.topic || null, kind: msg.kind,
  });
  const waiter = waiters.get(toId);
  if (waiter) {
    waiters.delete(toId);
    clearTimeout(waiter.timer);
    // Anything already queued goes out with it, and this message needs its own
    // deliver record — it never passes through the queue, so without this it
    // would be replayed as unread after a restart.
    const queued = drain(toId, spaceId);
    append(spaceId, { t: 'deliver', id: msg.id, to: toId });
    waiter.resolve([...queued, msg]);
  } else {
    queueFor(toId).push(msg);
    onEvent({ type: 'mail', to: toId, from: msg.fromName, subject: msg.subject });
  }
}

// Hand the queue to a caller and mark those messages delivered. At-most-once:
// if the agent dies right after, the message is gone from the queue but still
// readable in the log.
function drain(id, spaceId) {
  const q = pending.get(id) || [];
  pending.set(id, []);
  for (const m of q) append(spaceId, { t: 'deliver', id: m.id, to: id });
  if (q.length) onEvent({ type: 'read', by: id });
  return q;
}

function allowed(id) {
  const now = Date.now();
  const bucket = rate.get(id);
  if (!bucket || now > bucket.resetAt) {
    rate.set(id, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT) return false;
  bucket.count++;
  return true;
}

// --- identity -------------------------------------------------------------

function describe(termId) {
  const live = roster.get(termId);
  const prof = profiles.get(termId) || {};
  if (!live) return null;
  return {
    id: termId,
    name: live.name,
    type: live.type,
    status: live.status,
    space: live.spaceId,
    spaceName: live.spaceName,
    role: prof.role || null,
    skills: prof.skills || [],
    cwd: prof.cwd || null,
    registered: !!prof.registeredAt,
  };
}

function peersOf(termId) {
  const me = roster.get(termId);
  if (!me) return [];
  return [...roster.keys()]
    .filter((id) => roster.get(id).spaceId === me.spaceId)
    .map(describe)
    .filter(Boolean);
}

// Resolve a recipient by id or (case-insensitive) name, within the sender's
// workspace only — the bus is scoped per workspace by design.
function resolveTargets(fromId, to) {
  const peers = peersOf(fromId).filter((p) => p.id !== fromId);
  if (!to || to === '@all' || to === 'all') return peers;
  const needle = String(to).toLowerCase();
  return peers.filter((p) => p.id === to || p.name.toLowerCase() === needle);
}

// --- HTTP -----------------------------------------------------------------

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

async function handle(req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const route = parsed.pathname;

  if (route === '/health') return send(res, 200, { ok: true, agents: roster.size });

  // A browser tab on any site can reach 127.0.0.1; a request that carries an
  // Origin is by definition not our CLI, so refuse it outright.
  if (req.headers.origin) return send(res, 403, { error: 'origin not allowed' });

  const auth = req.headers.authorization || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const ok = supplied.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  if (!ok) return send(res, 401, { error: 'bad token' });

  const me = req.headers['x-termivin-agent'] || parsed.searchParams.get('agent');
  if (!me) return send(res, 400, { error: 'missing agent id (TERMIVIN_AGENT)' });
  if (!roster.has(me)) return send(res, 404, { error: 'unknown agent: ' + me });

  if (route === '/agents' && req.method === 'GET') {
    return send(res, 200, { me: describe(me), agents: peersOf(me) });
  }

  if (route === '/register' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: 'invalid json' });
    profiles.set(me, {
      role: body.role ? String(body.role).slice(0, 500) : null,
      skills: Array.isArray(body.skills) ? body.skills.slice(0, 20).map(String) : [],
      cwd: body.cwd ? String(body.cwd) : null,
      registeredAt: Date.now(),
    });
    onEvent({ type: 'register', id: me });
    return send(res, 200, { ok: true, me: describe(me), peers: peersOf(me).filter((p) => p.id !== me) });
  }

  if (route === '/publish' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: 'invalid json' });
    if (!allowed(me)) return send(res, 429, { error: 'rate limit: 20 messages/minute' });

    // "#name" (or "topic:name") addresses a topic instead of an agent:
    // same-workspace senders broadcast to every agent in the topic's
    // workspace; senders elsewhere reach only the topic's representative.
    let targets;
    let topicName = null;
    const rawTo = String(body.to || '');
    const topicMatch = rawTo.match(/^#(.+)$/) || rawTo.match(/^topic:(.+)$/i);
    if (topicMatch) {
      const topic = findTopicByName(topicMatch[1]);
      if (!topic) return send(res, 404, { error: `no such topic: #${topicMatch[1]}` });
      topicName = topic.name;
      const mySpace = roster.get(me).spaceId;
      if (topic.spaceId === mySpace) {
        targets = agentsInSpace(topic.spaceId)
          .filter((a) => a.termId !== me)
          .map((a) => describe(a.termId))
          .filter(Boolean);
        if (!targets.length) {
          return send(res, 404, { error: `no other agents in workspace for topic #${topic.name}` });
        }
      } else {
        const rep = topicRepresentative(topic);
        if (!rep) {
          return send(res, 404, { error: `topic #${topic.name} has no live agent to represent it` });
        }
        targets = [describe(rep.termId)].filter(Boolean);
      }
    } else {
      targets = resolveTargets(me, body.to);
      if (!targets.length) {
        return send(res, 404, { error: `no such agent in this workspace: ${body.to || '@all'}` });
      }
    }
    const ttl = Math.min(Number(body.ttl) || DEFAULT_TTL, DEFAULT_TTL);
    if (ttl <= 0) return send(res, 200, { ok: true, delivered: 0, note: 'ttl exhausted' });

    const mine = describe(me);
    const base = {
      ts: Date.now(),
      from: me,
      fromName: mine.name,
      kind: body.kind || 'note',
      subject: body.subject ? String(body.subject).slice(0, 200) : '',
      body: String(body.body || '').slice(0, 20000),
      corr: body.corr || null,
      ttl: ttl - 1,
      topic: topicName,
      broadcast: targets.length > 1,
    };
    for (const t of targets) {
      deliver(t.id, { ...base, id: 'm_' + crypto.randomBytes(5).toString('hex'), to: t.id, toName: t.name },
        t.space);
    }
    return send(res, 200, { ok: true, delivered: targets.map((t) => t.name), topic: topicName });
  }

  if (route === '/topics' && req.method === 'GET') {
    return send(res, 200, { topics: describeTopics() });
  }

  // Create (or claim) a topic from an agent. The topic is anchored to the
  // sender's workspace; the sender becomes the representative unless --rep
  // names another agent in the same workspace.
  if (route === '/topics' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: 'invalid json' });
    const mySpace = roster.get(me).spaceId;
    let repId = me;
    if (body.rep) {
      const needle = String(body.rep).toLowerCase();
      const found = agentsInSpace(mySpace).find(
        (a) => a.termId === body.rep || a.name.toLowerCase() === needle);
      if (!found) return send(res, 404, { error: `no such agent in this workspace: ${body.rep}` });
      repId = found.termId;
    }
    const r = createTopic(body.name, mySpace, repId);
    if (!r.ok) return send(res, 409, { error: r.error });
    return send(res, 200, { ok: true, topic: describeTopic(r.topic) });
  }

  if (route === '/recv' && req.method === 'GET') {
    const space = roster.get(me).spaceId;
    const queued = drain(me, space);
    if (queued.length) return send(res, 200, { messages: queued });

    const wait = Math.min(Math.max(Number(parsed.searchParams.get('wait')) || 0, 0), MAX_WAIT_MS / 1000);
    if (!wait) return send(res, 200, { messages: [] });

    // Only one waiter per agent: a second poll replaces the first.
    const existing = waiters.get(me);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve([]);
    }
    const messages = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(me);
        resolve([]);
      }, wait * 1000);
      waiters.set(me, { resolve, timer });
      req.on('close', () => {
        if (waiters.get(me) && waiters.get(me).timer === timer) {
          waiters.delete(me);
          clearTimeout(timer);
          resolve([]);
        }
      });
    });
    if (res.writableEnded) return;
    return send(res, 200, { messages });
  }

  return send(res, 404, { error: 'no such route' });
}

// --- snapshots for the renderer -------------------------------------------

function describeTopic(t) {
  const space = agentsInSpace(t.spaceId)[0];
  const rep = topicRepresentative(t);
  return {
    id: t.id,
    name: t.name,
    spaceId: t.spaceId,
    spaceName: space ? space.spaceName : null,
    repId: t.repId,
    repName: t.repId && roster.has(t.repId) ? roster.get(t.repId).name : null,
    effectiveRepId: rep ? rep.termId : null,
    effectiveRepName: rep ? rep.name : null,
    members: agentsInSpace(t.spaceId).length,
    createdAt: t.createdAt,
  };
}

function describeTopics() {
  return [...topics.values()].map(describeTopic);
}

// Everything the dashboard maps need in one call.
function stats() {
  return {
    agents: [...roster.keys()].map(describe).filter(Boolean).map((a) => ({
      ...a,
      pending: pendingCount(a.id),
      traffic: agentTraffic.get(a.id) || { sent: 0, recv: 0 },
    })),
    topics: describeTopics(),
    links: [...linkCounts.entries()].map(([k, count]) => {
      const [from, to] = k.split('>');
      return { from, to, count };
    }),
    spaceLinks: [...spaceLinks.entries()].map(([k, count]) => {
      const [from, to] = k.split('>');
      return { from, to, count };
    }),
    recent: recentMessages.slice(-60),
  };
}

// --- lifecycle ------------------------------------------------------------

function start(userDataDir, eventSink) {
  if (server) return { url, token };
  dataDir = path.join(userDataDir, 'bus');
  onEvent = typeof eventSink === 'function' ? eventSink : () => {};
  token = crypto.randomBytes(24).toString('hex');
  replayLogs();
  loadTopics();

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[bus]', err);
      if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
    });
  });
  server.on('error', (err) => console.error('[bus] server error:', err.message));
  server.listen(0, '127.0.0.1', () => {
    url = `http://127.0.0.1:${server.address().port}`;
    try {
      fs.writeFileSync(
        path.join(userDataDir, 'bus.json'),
        JSON.stringify({ url, token, pid: process.pid }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (err) {
      console.error('[bus] could not write bus.json:', err.message);
    }
  });
  return info();
}

// The renderer owns terminal status, so it pushes the roster here on every
// render and status change. This is also what scopes the bus per workspace.
function setRoster(list) {
  const next = new Map();
  for (const t of list || []) next.set(t.termId, t);
  for (const id of roster.keys()) {
    if (!next.has(id)) {
      profiles.delete(id);
      const w = waiters.get(id);
      if (w) {
        waiters.delete(id);
        clearTimeout(w.timer);
        w.resolve([]);
      }
    }
  }
  roster = next;
}

function info() {
  return { url, token, agents: roster.size };
}

// How many messages are waiting for a terminal — drives the 📬 badge.
function pendingCount(termId) {
  return (pending.get(termId) || []).length;
}

function stop() {
  for (const w of waiters.values()) {
    clearTimeout(w.timer);
    w.resolve([]);
  }
  waiters.clear();
  // Drop in-memory state too: start() replays the log, so leaving the old
  // queues in place would double every undelivered message on a restart.
  pending.clear();
  profiles.clear();
  rate.clear();
  topics.clear();
  linkCounts.clear();
  agentTraffic.clear();
  spaceLinks.clear();
  recentMessages.length = 0;
  roster = new Map();
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
}

module.exports = {
  start, stop, setRoster, info, pendingCount,
  stats, createTopic, updateTopic, deleteTopic,
};
