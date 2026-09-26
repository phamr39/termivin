// Remote controller: ties the session hub, the agent bus, the chat store and
// the relay link together, and answers the phone's commands. Commands that
// change the workspace model (create / restart / rename …) are executed by the
// renderer, which owns that state, through a small IPC request/response.

const path = require('path');
const { HostLink } = require('./host-link');
const { ChatStore } = require('./chat');
const { TranscriptWatcher } = require('./transcripts');
const { TurnTracker, screenSummary, headline } = require('./turns');

const SNAPSHOT_DEBOUNCE_MS = 400;
const TRANSCRIPT_POLL_MS = 2500;
const RENDERER_TIMEOUT_MS = 15000;
const PROMPT_ENTER_DELAY_MS = 150;
const PROGRESS_THROTTLE_MS = 700;
const SCREEN_TURN_MIN_MS = 3500; // a command that never printed still counts as done after this

// Keys a phone may send without the "input" scope: quick replies only.
const QUICK_KEYS = {
  enter: '\r', esc: '\x1b', tab: '\t', 'shift+tab': '\x1b[Z', 'ctrl+c': '\x03',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', space: ' ', backspace: '\x7f',
  y: 'y', n: 'n', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
};

const AGENT_TYPES = new Set(['claude', 'codex']);
const RENDERER_OPS = new Set([
  'term.restore', 'term.stop', 'term.restart', 'term.create', 'term.rename', 'term.mode',
]);

function createRemote({ userData, hub, bus, ptys, invokeRenderer, recentProjects, platform, version, notifyRenderer }) {
  const dir = path.join(userData, 'remote');
  const link = new HostLink(dir);
  const chat = new ChatStore(path.join(dir, 'chat'));
  let appState = null; // last state the renderer saved
  const subs = new Set(); // termIds a phone is watching
  const pendingPrompts = new Map(); // termId -> [{ conv, id, text }]
  const sentPrompts = new Map(); // termId -> [{ text, ts }] — to skip our own echo in transcripts
  let snapshotTimer = null;
  let attentionTimer = null;

  // --- model views ----------------------------------------------------------

  function terminals() {
    const out = [];
    for (const ws of (appState && appState.workspaces) || []) {
      for (const t of ws.terminals) out.push({ ws, t });
    }
    return out;
  }

  function findTerm(termId) {
    return terminals().find((x) => x.t.id === termId) || null;
  }

  function describe(termId) {
    const f = findTerm(termId);
    return f ? { name: f.t.name, spaceId: f.ws.id, spaceName: f.ws.name, type: f.t.type } : null;
  }

  function termStatus(t) {
    if (t.external) return 'attached';
    const s = hub.get(t.id);
    if (!s) return 'saved';
    return s.status;
  }

  function snapshot() {
    const busStats = safe(() => bus.stats(), { agents: [], topics: [], openAsks: [] });
    const pendingByAgent = new Map(busStats.agents.map((a) => [a.id, a.pending]));
    return {
      host: { name: link.config ? link.config.name : '', platform, version },
      activeWorkspaceId: appState ? appState.activeWorkspaceId : null,
      workspaces: ((appState && appState.workspaces) || []).map((ws) => ({
        id: ws.id,
        name: ws.name,
        terminals: ws.terminals.map((t) => {
          const s = hub.get(t.id);
          return {
            id: t.id,
            name: t.name,
            type: t.type,
            cwd: t.cwd || '',
            status: termStatus(t),
            summary: s ? s.summary : (t.savedTail && t.savedTail.length ? String(t.savedTail[t.savedTail.length - 1]).slice(0, 140) : ''),
            external: !!t.external,
            dockGroup: t.dockGroup || null,
            minimized: !!t.minimized,
            permissionMode: (/--permission-mode(?:=|\s+)(\w+)/.exec(t.restoreCommand || t.command || '') || [])[1] || '',
            restoreCommand: t.restoreCommand || '',
            pendingMail: pendingByAgent.get(t.id) || 0,
            exitCode: s && !s.running ? s.exitCode : null,
            startedAt: s ? s.startedAt : null,
            title: turns.title(t.id),
          };
        }),
      })),
      topics: busStats.topics.map((tp) => ({ id: tp.id, name: tp.name, spaceId: tp.spaceId, rep: tp.effectiveRepName || tp.repName || null })),
    };
  }

  function attention() {
    const items = hub.attention(describe);
    const busStats = safe(() => bus.stats(), { openAsks: [] });
    for (const a of busStats.openAsks || []) {
      if (!describe(a.to)) continue;
      items.push({
        id: `ask:${a.key}`, kind: 'ask', termId: a.to, spaceId: a.toSpace,
        title: `${a.fromName} → ${a.toName}`, excerpt: a.subject || a.body || '', since: a.ts,
      });
    }
    return items.sort((x, y) => x.since - y.since);
  }

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  // --- pushing state up -------------------------------------------------------

  function pushSnapshot() {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      if (link.online) link.sendJson({ t: 'snapshot', data: snapshot() });
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  function pushAttention() {
    clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => {
      if (link.online) link.sendJson({ t: 'attention', items: attention() });
    }, 150);
  }

  link.on('online', () => {
    link.sendJson({ t: 'snapshot', data: snapshot() });
    link.sendJson({ t: 'attention', items: attention() });
    for (const termId of subs) sendScreen(termId);
  });
  link.on('offline', () => subs.clear());
  link.on('state', (info) => notifyRenderer('remote:state', info));

  hub.on('status', (termId) => {
    pushSnapshot();
    if (hub.status(termId) === 'idle') flushPrompt(termId);
    checkScreenTurn(termId);
  });
  hub.on('attention', pushAttention);
  hub.on('data', (termId, seq, data) => {
    if (subs.has(termId)) link.sendFrame(termId, seq, data);
  });

  // --- streaming a terminal to a phone ----------------------------------------

  function sendScreen(termId) {
    const scr = hub.screen(termId);
    if (scr) link.sendJson({ t: 'event', kind: 'screen', data: { termId, ...scr } });
    else link.sendJson({ t: 'event', kind: 'screen', data: { termId, seq: 0, cols: 80, rows: 24, data: '', stopped: true } });
  }

  link.on('sub', ({ termId, lastSeq }) => {
    subs.add(termId);
    const missing = Number.isInteger(lastSeq) ? hub.since(termId, lastSeq) : null;
    if (missing === null) return sendScreen(termId);
    if (missing) link.sendFrame(termId, lastSeq, missing);
  });
  link.on('unsub', ({ termId }) => subs.delete(termId));

  // --- chat ---------------------------------------------------------------------

  chat.on('message', (conv, msg) => {
    if (link.online) link.sendJson({ t: 'event', kind: 'chat', data: { conv, msg } });
    notifyRenderer('remote:chat', { conv, msg });
  });
  chat.on('update', (conv, msg) => {
    if (link.online) link.sendJson({ t: 'event', kind: 'chat', data: { conv, msg } });
  });

  // One chat message per turn of work (see turns.js); progress in between.
  const progressAt = new Map(); // termId -> last progress sent
  function sendProgress(termId, info) {
    if (!link.online) return;
    const now = Date.now();
    if (info && now - (progressAt.get(termId) || 0) < PROGRESS_THROTTLE_MS) return;
    progressAt.set(termId, info ? now : 0);
    link.sendJson({ t: 'event', kind: 'progress', data: { conv: 'dm:' + termId, termId, active: !!info, ...(info || {}) } });
  }

  const turns = new TurnTracker({
    post(termId, msg, { notify }) {
      const who = describe(termId);
      if (!who) return;
      chat.add('dm:' + termId, { ...msg, from: termId, fromName: who.name, notify: !!notify });
    },
    prompt(termId, e) {
      const who = describe(termId);
      if (!who) return;
      // A prompt the phone typed comes back through the transcript — the
      // chat already shows it as the owner's message.
      const mine = sentPrompts.get(termId) || [];
      const k = mine.findIndex((m) => norm(m.text) === norm(e.text));
      if (k !== -1) {
        mine.splice(k, 1);
        return;
      }
      chat.add('dm:' + termId, {
        id: e.id, ts: e.ts, kind: 'text', text: e.text, role: 'desktop', from: 'desktop', fromName: 'You (desktop)',
      });
    },
    progress: sendProgress,
  });

  const transcripts = new TranscriptWatcher((termId, events, opts) => turns.onEvents(termId, events, opts));

  // Terminals without a transcript: a prompt from the phone opens a turn, the
  // terminal going quiet closes it, and the summary is what it printed.
  const screenTurns = new Map(); // termId -> { id, mark, startedAt, text, sawWorking }
  function openScreenTurn(termId, text) {
    const s = hub.get(termId);
    if (!s) return;
    const who = describe(termId);
    if (!who || who.type === 'claude') return;
    screenTurns.set(termId, { id: 'turn:scr:' + Date.now().toString(36), mark: hub.mark(termId), startedAt: Date.now(), text, sawWorking: false });
    sendProgress(termId, { startedAt: Date.now(), steps: 0, last: text.slice(0, 120) });
  }
  function checkScreenTurn(termId) {
    const t = screenTurns.get(termId);
    if (!t) return;
    const st = hub.status(termId);
    if (st === 'working' || st === 'approval') {
      t.sawWorking = true;
      return;
    }
    if (st !== 'idle' && st !== 'exited') return;
    if (!t.sawWorking && Date.now() - t.startedAt < SCREEN_TURN_MIN_MS) return;
    screenTurns.delete(termId);
    sendProgress(termId, null);
    const summary = screenSummary(hub.linesSince(termId, t.mark), t.text);
    const who = describe(termId);
    if (!who) return;
    const lastLine = summary.split('\n').filter(Boolean).pop() || '';
    chat.add('dm:' + termId, {
      id: t.id, kind: 'summary', role: 'agent', from: termId, fromName: who.name, mono: true,
      text: summary || '(no output)', headline: headline(lastLine) || 'Finished',
      prompt: t.text.slice(0, 300), steps: [],
      stats: { durationMs: Date.now() - t.startedAt, exited: st === 'exited' },
      notify: true,
    });
  }

  function norm(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  const pollTimer = setInterval(() => {
    if (!link.config || !link.config.enabled) return;
    const terms = terminals()
      .filter(({ t }) => t.type === 'claude' && hub.get(t.id) && hub.get(t.id).running)
      .map(({ t }) => ({ termId: t.id, cwd: t.cwd, startedAt: hub.get(t.id).startedAt }));
    transcripts.poll(terms);
    for (const t of terms) turns.tick(t.termId, { idle: hub.status(t.termId) === 'idle' });
    for (const termId of screenTurns.keys()) checkScreenTurn(termId);
  }, TRANSCRIPT_POLL_MS);

  function onBusEvent(evt) {
    if (evt.type === 'msg' && evt.body != null) {
      if (evt.from === 'owner') return; // recorded when the owner sent it
      if (!evt.toSpace) return;
      chat.add('ws:' + evt.toSpace, {
        id: 'bus:' + evt.mid, ts: evt.ts, role: 'agent', kind: 'bus',
        from: evt.from, fromName: evt.fromName,
        to: evt.broadcast ? '@all' : evt.to, toName: evt.broadcast ? 'everyone' : evt.toName,
        topic: evt.topic || null, subject: evt.subject || '', text: evt.body,
      });
    } else if (evt.type === 'owner' && evt.msg) {
      const m = evt.msg;
      chat.add('dm:' + m.from, {
        id: 'bus:' + m.mid, ts: m.ts, role: 'agent', kind: 'text', from: m.from, fromName: m.fromName,
        subject: m.subject || '', text: m.body, via: 'bus', notify: true,
      });
    }
    if (evt.type === 'msg' || evt.type === 'register' || evt.type === 'topic') pushSnapshot();
    if (evt.type === 'msg' || evt.type === 'read') pushAttention();
  }

  function typeInto(termId, text) {
    const p = ptys.get(termId);
    if (!p) return false;
    const agent = AGENT_TYPES.has((describe(termId) || {}).type);
    // Multi-line text goes in as a bracketed paste so its newlines don't submit early.
    const body = agent && /\n/.test(text) ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r?\n/g, ' ');
    p.write(body);
    setTimeout(() => {
      const again = ptys.get(termId);
      if (again === p) p.write('\r');
    }, PROMPT_ENTER_DELAY_MS);
    return true;
  }

  function flushPrompt(termId) {
    const queue = pendingPrompts.get(termId);
    if (!queue || !queue.length) return;
    const s = hub.get(termId);
    if (!s || s.status !== 'idle' || s.approval) return;
    const next = queue.shift();
    if (!queue.length) pendingPrompts.delete(termId);
    if (typeInto(termId, next.text)) {
      rememberPrompt(termId, next.text);
      openScreenTurn(termId, next.text);
      chat.update(next.conv, next.id, { state: 'delivered' });
    }
  }

  function rememberPrompt(termId, text) {
    const list = sentPrompts.get(termId) || [];
    list.push({ text, ts: Date.now() });
    while (list.length > 20) list.shift();
    sentPrompts.set(termId, list);
  }

  function chatSend({ conv, text, mode }) {
    text = String(text || '').slice(0, 8000);
    if (!text.trim()) throw new Error('empty message');
    const id = 'own:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (conv.startsWith('ws:')) {
      const spaceId = conv.slice(3);
      const r = bus.ownerSend({ to: '@all', spaceId, body: text });
      if (!r.ok) throw new Error(r.error === 'no_recipients' ? 'No agents are running in this workspace' : r.error);
      chat.add(conv, { id: 'bus:' + r.mid, role: 'owner', kind: 'text', from: 'owner', fromName: 'You', text, to: '@all', state: 'delivered' });
      return { id: 'bus:' + r.mid, delivered: r.delivered };
    }
    if (!conv.startsWith('dm:')) throw new Error('unknown conversation');
    const termId = conv.slice(3);
    const who = describe(termId);
    if (!who) throw new Error('no such terminal');
    const useBus = mode === 'bus';
    if (useBus) {
      const r = bus.ownerSend({ to: termId, body: text });
      if (!r.ok) throw new Error('This terminal is not on the agent bus');
      chat.add(conv, { id: 'bus:' + r.mid, role: 'owner', kind: 'text', from: 'owner', fromName: 'You', text, via: 'bus', state: 'delivered' });
      return { id: 'bus:' + r.mid, state: 'delivered' };
    }
    const s = hub.get(termId);
    if (!s || !s.running) throw new Error('The terminal is not running');
    if (s.status === 'idle' && !s.approval) {
      typeInto(termId, text);
      rememberPrompt(termId, text);
      openScreenTurn(termId, text);
      chat.add(conv, { id, role: 'owner', kind: 'text', from: 'owner', fromName: 'You', text, via: 'prompt', state: 'delivered' });
      return { id, state: 'delivered' };
    }
    // Busy or waiting for an approval: typing now would land in the middle of
    // its work (or answer the prompt) — deliver at the next idle instead.
    const queue = pendingPrompts.get(termId) || [];
    queue.push({ conv, id, text });
    pendingPrompts.set(termId, queue);
    chat.add(conv, { id, role: 'owner', kind: 'text', from: 'owner', fromName: 'You', text, via: 'prompt', state: 'queued' });
    return { id, state: 'queued' };
  }

  function chatList() {
    const out = [];
    for (const ws of (appState && appState.workspaces) || []) {
      const group = 'ws:' + ws.id;
      out.push({
        conv: group, kind: 'group', title: ws.name, spaceId: ws.id,
        members: ws.terminals.filter((t) => !t.external).map((t) => ({ id: t.id, name: t.name, type: t.type, status: termStatus(t) })),
        last: chat.lastMessage(group), unread: chat.unread(group),
      });
      for (const t of ws.terminals) {
        if (t.external) continue;
        const conv = 'dm:' + t.id;
        out.push({
          conv, kind: 'dm', title: t.name, spaceId: ws.id, spaceName: ws.name,
          termId: t.id, type: t.type, status: termStatus(t),
          last: chat.lastMessage(conv), unread: chat.unread(conv),
        });
      }
    }
    return out;
  }

  // --- commands from the phone -------------------------------------------------------

  async function handleCmd(op, args, deviceId) {
    args = args || {};
    const termId = typeof args.termId === 'string' ? args.termId : null;
    switch (op) {
      case 'approval.answer': {
        const r = hub.answer(termId, args);
        if (!r.ok) throw new Error(r.error);
        const p = ptys.get(termId);
        if (!p) throw new Error('not_running');
        p.write(r.keys);
        chat.add('dm:' + termId, {
          id: 'sys:' + Date.now().toString(36), role: 'system', kind: 'system', from: 'owner',
          text: `Answered "${args.label || args.option}" from the phone`,
        });
        return { answered: true };
      }
      case 'term.keys': {
        const p = ptys.get(termId);
        if (!p) throw new Error('not_running');
        const names = Array.isArray(args.keys) ? args.keys : [args.keys];
        const seq = names.map((k) => QUICK_KEYS[String(k).toLowerCase()]);
        if (!names.length || seq.some((k) => k == null)) throw new Error('unsupported key');
        p.write(seq.join(''));
        return {};
      }
      case 'term.input': {
        const p = ptys.get(termId);
        if (!p) throw new Error('not_running');
        p.write(String(args.data || '').slice(0, 4096));
        return {};
      }
      case 'bus.push': {
        const s = hub.get(termId);
        if (!s || !s.running) throw new Error('not_running');
        if (s.status !== 'idle' || s.approval) throw new Error('busy');
        typeInto(termId, 'termivin recv --wait 60');
        return {};
      }
      case 'bus.send': {
        const r = bus.ownerSend({ to: args.to, spaceId: args.spaceId, body: args.body, subject: args.subject || '' });
        if (!r.ok) throw new Error(r.error);
        return r;
      }
      case 'chat.list':
        return chatList();
      case 'chat.history':
        return chat.history(String(args.conv || ''), { before: args.before, limit: args.limit });
      case 'chat.read':
        chat.markRead(String(args.conv || ''), args.ts);
        return {};
      case 'chat.send':
        return chatSend(args);
      case 'term.presets':
        return { recentProjects: safe(() => recentProjects(), []), home: require('os').homedir() };
      default:
        if (RENDERER_OPS.has(op)) return invokeRenderer(op, args);
        throw new Error('unknown_op');
    }
  }

  link.on('cmd', async ({ id, op, args, deviceId }) => {
    try {
      const data = await handleCmd(op, args, deviceId);
      link.sendJson({ t: 'cmd.result', id, ok: true, data });
    } catch (err) {
      link.sendJson({ t: 'cmd.result', id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  return {
    link,
    chat,
    start: () => link.start(),
    stop() {
      clearInterval(pollTimer);
      clearTimeout(snapshotTimer);
      clearTimeout(attentionTimer);
      link.disconnect();
    },
    setState(state) {
      appState = state;
      pushSnapshot();
      pushAttention();
    },
    onBusEvent,
    handleCmd, // exposed for tests
    snapshot,
    attention,
  };
}

// Renderer request/response over IPC (main → renderer 'remote:cmd',
// renderer → main 'remote:cmd-result').
function rendererBridge(ipcMain, getWin) {
  let seq = 0;
  const waiting = new Map();
  ipcMain.on('remote:cmd-result', (event, { id, ok, data, error }) => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    if (ok) w.resolve(data);
    else w.reject(new Error(error || 'failed'));
  });
  return (op, args) => new Promise((resolve, reject) => {
    const win = getWin();
    if (!win || win.isDestroyed()) return reject(new Error('Termivin window is not open'));
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('timeout'));
    }, RENDERER_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    win.webContents.send('remote:cmd', { id, op, args });
  });
}

module.exports = { createRemote, rendererBridge };
