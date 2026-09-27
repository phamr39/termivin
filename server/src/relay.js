// Routing core: one socket per host (a PC running Termivin) and per device
// (a phone). The relay authenticates both ends, fans host state out to every
// device granted on that host, forwards commands the other way with a scope
// check, and keeps just enough in memory (last snapshot + attention list) for a
// phone to show something while its PC is offline. Wire format: docs/REMOTE.md.

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { issueAccess, verifyAccess, verifyHostSig } from './tokens.js';

const AUTH_TIMEOUT_MS = 10000;
const PING_MS = 20000;
const CMD_TIMEOUT_MS = 30000;
const DEDUPE_MS = 10 * 60 * 1000;
const OFFLINE_PUSH_GRACE_MS = 60000;

// op -> scope needed. Anything not listed is refused.
export const OP_SCOPES = {
  'approval.answer': 'approve',
  'bus.push': 'approve',
  'bus.send': 'approve',
  'term.keys': 'approve',
  'term.input': 'input',
  'term.restore': 'manage',
  'term.stop': 'manage',
  'term.restart': 'manage',
  'term.create': 'manage',
  'term.clone': 'manage',
  'term.rename': 'manage',
  'term.move': 'manage',
  'term.mode': 'manage',
  'term.presets': 'view',
  'chat.list': 'view',
  'chat.history': 'view',
  'chat.read': 'view',
  'chat.send': 'input',
  'media.get': 'view',
  'screen.capture': 'manage',
  // Answered by the relay itself.
  'relay.activity': 'view',
  'relay.audit': 'manage',
  'relay.devices': 'manage',
  'relay.revoke': 'manage',
};

// Ops whose args are too sensitive or too big to keep verbatim in the audit log.
const AUDIT_REDACT = { 'term.input': (a) => ({ termId: a?.termId, bytes: String(a?.data ?? '').length }) };

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function parse(data, isBinary) {
  if (isBinary) return null;
  try {
    const msg = JSON.parse(data.toString());
    return msg && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}

// --- binary PTY frames ------------------------------------------------------
// host→relay:   u8 termIdLen | termId | u32be seq | bytes
// relay→device: u8 hostIdLen | hostId | u8 termIdLen | termId | u32be seq | bytes

export function parseHostFrame(buf) {
  if (buf.length < 1) return null;
  const tl = buf[0];
  if (!tl || buf.length < 1 + tl + 4) return null;
  return { termId: buf.subarray(1, 1 + tl).toString('utf8'), rest: buf.subarray(1 + tl) };
}

export function deviceFrame(hostId, hostFrameBuf) {
  const hid = Buffer.from(hostId, 'utf8');
  return Buffer.concat([Buffer.from([hid.length]), hid, hostFrameBuf]);
}

// Token bucket per device socket — quick replies and typing are chatty, a
// runaway client is not.
function bucket(rate, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function createRelay({ db, cfg, push, log = () => {} }) {
  // hostId -> { ws, online, lastSeen, snapshot, attention, subs: Map<termId, Set<dconn>>, pendingCmds: Map }
  const hosts = new Map();
  // deviceId -> Set<dconn>;  dconn = { ws, deviceId, grants: Map<hostId, Set<scope>>, subs: Set<'hostId\0termId'> }
  const devices = new Map();
  // `${deviceId}:${cmdId}` -> { ts, result? , waiting: dconn[] }
  const dedupe = new Map();

  let closing = false;

  const hostWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  function hostState(hostId) {
    let h = hosts.get(hostId);
    if (!h) {
      const row = db.getHost(hostId);
      h = {
        ws: null, online: false, lastSeen: row?.last_seen || null, name: row?.name || hostId,
        snapshot: null, attention: [], subs: new Map(), pendingCmds: new Map(), offlineTimer: null,
      };
      hosts.set(hostId, h);
    }
    return h;
  }

  function devicesOn(hostId) {
    const out = [];
    for (const set of devices.values()) {
      for (const d of set) if (d.grants.has(hostId)) out.push(d);
    }
    return out;
  }

  function broadcast(hostId, msg) {
    const json = JSON.stringify(msg);
    for (const d of devicesOn(hostId)) if (d.ws.readyState === 1) d.ws.send(json);
  }

  function hostSummary(hostId, scopes) {
    const h = hostState(hostId);
    return { hostId, name: h.name, online: h.online, lastSeen: h.lastSeen, scopes };
  }

  // ---- push: only for items that need a human, never for chatter ----------
  function pushNewAttention(hostId, before, after) {
    if (!push) return;
    const seen = new Set(before.map((a) => a.id));
    const fresh = after.filter((a) => !seen.has(a.id) && (a.kind === 'approval' || a.kind === 'exited'));
    if (!fresh.length) return;
    const h = hostState(hostId);
    for (const item of fresh) {
      push.send(db.devicesForHost(hostId), {
        title: item.kind === 'approval' ? `${item.title} needs your approval` : `${item.title} stopped`,
        body: `${h.name} · ${item.excerpt || ''}`.slice(0, 180),
        data: { hostId, attentionId: item.id, termId: item.termId || '', kind: item.kind },
        category: item.kind === 'approval' ? 'APPROVAL' : 'DEFAULT',
      });
    }
  }

  // ---- host sockets -------------------------------------------------------
  hostWss.on('connection', (ws) => {
    const nonce = crypto.randomBytes(32).toString('base64url');
    let hostId = null;
    let alive = true;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);
    send(ws, { t: 'challenge', nonce });

    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);

    ws.on('message', (data, isBinary) => {
      if (!hostId) {
        const msg = parse(data, isBinary);
        const row = msg && msg.t === 'auth' && typeof msg.hostId === 'string' ? db.getHost(msg.hostId) : null;
        if (!row || !row.public_key || !verifyHostSig(row.public_key, nonce, msg.sig)) {
          log('host auth failed');
          return ws.close(4003, 'auth failed');
        }
        clearTimeout(authTimer);
        hostId = row.id;
        const h = hostState(hostId);
        if (h.ws && h.ws !== ws) h.ws.close(4009, 'replaced by a newer connection');
        clearTimeout(h.offlineTimer);
        h.ws = ws;
        h.online = true;
        h.name = row.name;
        h.lastSeen = Date.now();
        db.touchHost(hostId);
        send(ws, { t: 'ready', hostId, name: row.name });
        // Re-announce live subscriptions so streaming resumes after a reconnect.
        for (const termId of h.subs.keys()) send(ws, { t: 'sub', termId, lastSeq: null });
        broadcast(hostId, { t: 'host', hostId, online: true, lastSeen: h.lastSeen });
        log(`host online ${hostId}`);
        return;
      }
      if (isBinary) return onHostFrame(hostId, data);
      const msg = parse(data, false);
      if (msg) onHostMessage(hostId, ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      if (!hostId || closing) return;
      const h = hostState(hostId);
      if (h.ws !== ws) return; // replaced
      h.ws = null;
      h.online = false;
      h.lastSeen = Date.now();
      db.touchHost(hostId);
      for (const [id, p] of h.pendingCmds) {
        clearTimeout(p.timer);
        finishCmd(p, { t: 'cmd.result', id: p.cmdId, ok: false, error: 'host_offline' });
        h.pendingCmds.delete(id);
      }
      broadcast(hostId, { t: 'host', hostId, online: false, lastSeen: h.lastSeen });
      h.offlineTimer = setTimeout(() => {
        if (h.online || !push) return;
        push.send(db.devicesForHost(hostId), {
          title: `${h.name} is offline`, body: 'The PC lost its connection to the relay.',
          data: { hostId, kind: 'host_offline' }, category: 'DEFAULT',
        });
      }, OFFLINE_PUSH_GRACE_MS);
      log(`host offline ${hostId}`);
    });
  });

  function onHostFrame(hostId, buf) {
    const f = parseHostFrame(buf);
    if (!f) return;
    const subs = hostState(hostId).subs.get(f.termId);
    if (!subs || !subs.size) return;
    const out = deviceFrame(hostId, buf);
    for (const d of subs) if (d.ws.readyState === 1) d.ws.send(out, { binary: true });
  }

  function onHostMessage(hostId, ws, msg) {
    const h = hostState(hostId);
    switch (msg.t) {
      case 'snapshot':
        h.snapshot = msg.data ?? null;
        broadcast(hostId, { t: 'snapshot', hostId, data: h.snapshot, stale: false });
        break;
      case 'attention': {
        const items = Array.isArray(msg.items) ? msg.items.slice(0, 200) : [];
        const before = h.attention;
        h.attention = items;
        broadcast(hostId, { t: 'attention', hostId, items });
        pushNewAttention(hostId, before, items);
        break;
      }
      case 'event': {
        if (typeof msg.kind !== 'string') break;
        if (msg.kind === 'screen' && msg.data?.termId) {
          // Only the devices subscribed to that terminal need the screen dump.
          const subs = h.subs.get(msg.data.termId);
          if (subs) for (const d of subs) send(d.ws, { t: 'event', hostId, kind: 'screen', data: msg.data });
          break;
        }
        if (msg.kind === 'activity') db.addActivity(hostId, msg.data?.kind || 'misc', msg.data);
        // An agent writing to the owner is worth a notification.
        if (msg.kind === 'chat' && msg.data?.msg?.notify && push) {
          const m = msg.data.msg;
          push.send(db.devicesForHost(hostId), {
            title: m.kind === 'summary' ? `${m.fromName || 'Agent'} finished` : (m.fromName || 'Termivin'),
            body: String(m.headline || m.text || '').slice(0, 180),
            data: { hostId, conv: msg.data.conv, kind: 'chat' },
            category: 'DEFAULT',
          });
        }
        broadcast(hostId, { t: 'event', hostId, kind: msg.kind, data: msg.data });
        break;
      }
      case 'cmd.result': {
        const p = h.pendingCmds.get(msg.id);
        if (!p) break;
        clearTimeout(p.timer);
        h.pendingCmds.delete(msg.id);
        const result = { t: 'cmd.result', id: p.cmdId, ok: !!msg.ok, data: msg.data, error: msg.error };
        db.audit({ deviceId: p.deviceId, hostId, op: p.op, args: p.auditArgs, ok: result.ok, error: result.error });
        finishCmd(p, result);
        break;
      }
      case 'pair.create': {
        const { token, expiresAt } = db.createPairToken(hostId, msg.scopes);
        send(ws, { t: 'pair.created', token, expiresAt, url: cfg.publicUrl || null });
        db.audit({ hostId, op: 'pair.create', args: { scopes: msg.scopes } });
        break;
      }
      case 'devices.list':
        send(ws, { t: 'devices', items: publicDevices(db.listDevices(hostId)) });
        break;
      case 'devices.revoke':
        if (typeof msg.deviceId === 'string' && db.revokeGrant(msg.deviceId, hostId)) {
          dropGrant(msg.deviceId, hostId);
          db.audit({ hostId, op: 'devices.revoke', args: { deviceId: msg.deviceId }, ok: true });
        }
        send(ws, { t: 'devices', items: publicDevices(db.listDevices(hostId)) });
        break;
      default:
        break;
    }
  }

  function publicDevices(rows) {
    return rows.map((r) => ({
      deviceId: r.id, name: r.name, platform: r.platform, lastSeen: r.last_seen,
      createdAt: r.created_at, scopes: r.scopes ? r.scopes.split(',') : undefined,
      online: devices.has(r.id),
    }));
  }

  // ---- device sockets -----------------------------------------------------
  deviceWss.on('connection', (ws) => {
    let conn = null;
    let alive = true;
    const allow = bucket(20, 60);
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);

    ws.on('message', (data, isBinary) => {
      const msg = parse(data, isBinary);
      if (!msg) return;
      if (!conn) {
        const deviceId = msg.t === 'auth' ? verifyAccess(db.tokenKey, msg.token) : null;
        const dev = deviceId ? db.getDevice(deviceId) : null;
        if (!dev || dev.revoked_at) return ws.close(4003, 'auth failed');
        clearTimeout(authTimer);
        conn = { ws, deviceId, grants: new Map(), subs: new Set() };
        const grants = db.grantsForDevice(deviceId);
        for (const g of grants) conn.grants.set(g.hostId, new Set(g.scopes));
        if (!devices.has(deviceId)) devices.set(deviceId, new Set());
        devices.get(deviceId).add(conn);
        db.touchDevice(deviceId);
        send(ws, { t: 'ready', deviceId, hosts: grants.map((g) => hostSummary(g.hostId, g.scopes)) });
        // Last known state for every host, flagged stale when the PC is offline.
        for (const g of grants) {
          const h = hostState(g.hostId);
          if (h.snapshot) send(ws, { t: 'snapshot', hostId: g.hostId, data: h.snapshot, stale: !h.online });
          send(ws, { t: 'attention', hostId: g.hostId, items: h.attention });
        }
        return;
      }
      if (!allow()) return send(ws, { t: 'error', error: 'rate_limited', ref: msg.id });
      onDeviceMessage(conn, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      if (!conn || closing) return;
      for (const key of [...conn.subs]) {
        const [hostId, termId] = key.split('\0');
        unsubscribe(conn, hostId, termId);
      }
      const set = devices.get(conn.deviceId);
      if (set) {
        set.delete(conn);
        if (!set.size) devices.delete(conn.deviceId);
      }
    });
  });

  function has(conn, hostId, scope) {
    return !!conn.grants.get(hostId)?.has(scope);
  }

  function subscribe(conn, hostId, termId, lastSeq) {
    const h = hostState(hostId);
    let set = h.subs.get(termId);
    if (!set) h.subs.set(termId, (set = new Set()));
    const first = set.size === 0;
    set.add(conn);
    conn.subs.add(`${hostId}\0${termId}`);
    // First viewer starts the stream; later viewers need the screen too, so
    // the host always gets the sub — it decides between a dump and a delta.
    if (h.ws) send(h.ws, { t: 'sub', termId, lastSeq: Number.isInteger(lastSeq) ? lastSeq : null, first });
  }

  function unsubscribe(conn, hostId, termId) {
    conn.subs.delete(`${hostId}\0${termId}`);
    const h = hosts.get(hostId);
    const set = h?.subs.get(termId);
    if (!set) return;
    set.delete(conn);
    if (!set.size) {
      h.subs.delete(termId);
      if (h.ws) send(h.ws, { t: 'unsub', termId });
    }
  }

  function onDeviceMessage(conn, msg) {
    const hostId = typeof msg.hostId === 'string' ? msg.hostId : null;
    switch (msg.t) {
      case 'sub':
        if (!hostId || typeof msg.termId !== 'string' || !has(conn, hostId, 'view')) {
          return send(conn.ws, { t: 'error', error: 'forbidden', ref: msg.termId });
        }
        return subscribe(conn, hostId, msg.termId.slice(0, 200), msg.lastSeq);
      case 'unsub':
        if (hostId && typeof msg.termId === 'string') unsubscribe(conn, hostId, msg.termId);
        return;
      case 'push.register':
        db.setPushToken(conn.deviceId, msg.token, msg.platform);
        return;
      case 'cmd':
        return onCmd(conn, hostId, msg);
      default:
        return;
    }
  }

  function finishCmd(entry, result) {
    const d = dedupe.get(entry.key);
    if (d) {
      d.result = result;
      for (const c of d.waiting) send(c.ws, result);
      d.waiting = [];
    }
  }

  function onCmd(conn, hostId, msg) {
    const reply = (ok, extra) => send(conn.ws, { t: 'cmd.result', id: msg.id, ok, ...extra });
    if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 80) return reply(false, { error: 'bad_id' });
    const scope = OP_SCOPES[msg.op];
    if (!scope) return reply(false, { error: 'unknown_op' });
    if (!hostId || !has(conn, hostId, scope)) {
      db.audit({ deviceId: conn.deviceId, hostId, op: msg.op, ok: false, error: 'forbidden' });
      return reply(false, { error: 'forbidden' });
    }

    const key = `${conn.deviceId}:${msg.id}`;
    const prior = dedupe.get(key);
    if (prior) {
      if (prior.result) send(conn.ws, prior.result);
      else prior.waiting.push(conn);
      return;
    }
    dedupe.set(key, { ts: Date.now(), result: null, waiting: [conn] });

    if (msg.op.startsWith('relay.')) {
      let result;
      try {
        result = { t: 'cmd.result', id: msg.id, ok: true, data: relayOp(conn, hostId, msg.op, msg.args || {}) };
      } catch (err) {
        result = { t: 'cmd.result', id: msg.id, ok: false, error: String(err.message || err) };
      }
      if (msg.op === 'relay.revoke') db.audit({ deviceId: conn.deviceId, hostId, op: msg.op, args: msg.args, ok: result.ok });
      return finishCmd({ key }, result);
    }

    const h = hostState(hostId);
    const auditArgs = AUDIT_REDACT[msg.op] ? AUDIT_REDACT[msg.op](msg.args) : msg.args;
    if (!h.online || !h.ws) {
      db.audit({ deviceId: conn.deviceId, hostId, op: msg.op, args: auditArgs, ok: false, error: 'host_offline' });
      return finishCmd({ key }, { t: 'cmd.result', id: msg.id, ok: false, error: 'host_offline' });
    }
    // The relay-side id keeps two devices that pick the same uuid apart.
    const relayId = crypto.randomBytes(8).toString('base64url');
    const entry = { key, cmdId: msg.id, deviceId: conn.deviceId, op: msg.op, auditArgs, timer: null };
    entry.timer = setTimeout(() => {
      h.pendingCmds.delete(relayId);
      db.audit({ deviceId: conn.deviceId, hostId, op: msg.op, args: auditArgs, ok: false, error: 'timeout' });
      finishCmd(entry, { t: 'cmd.result', id: msg.id, ok: false, error: 'timeout' });
    }, CMD_TIMEOUT_MS);
    h.pendingCmds.set(relayId, entry);
    send(h.ws, { t: 'cmd', id: relayId, deviceId: conn.deviceId, op: msg.op, args: msg.args || {} });
  }

  function relayOp(conn, hostId, op, args) {
    switch (op) {
      case 'relay.activity': {
        const ids = [...conn.grants.keys()].filter((id) => !hostId || id === hostId);
        return db.listActivity(ids, { before: args.before, limit: Math.min(200, args.limit || 100) });
      }
      case 'relay.audit':
        return db.listAudit({ hostId, limit: Math.min(500, args.limit || 100) });
      case 'relay.devices':
        return publicDevices(db.listDevices(hostId));
      case 'relay.revoke':
        if (typeof args.deviceId !== 'string') throw new Error('deviceId required');
        if (db.revokeGrant(args.deviceId, hostId)) dropGrant(args.deviceId, hostId);
        return publicDevices(db.listDevices(hostId));
      default:
        throw new Error('unknown_op');
    }
  }

  // A grant vanished: forget it on live sockets, and close sockets that have
  // nothing left to look at.
  function dropGrant(deviceId, hostId) {
    for (const c of devices.get(deviceId) || []) {
      for (const key of [...c.subs]) if (key.startsWith(`${hostId}\0`)) unsubscribe(c, hostId, key.slice(hostId.length + 1));
      c.grants.delete(hostId);
      if (!c.grants.size) c.ws.close(4003, 'revoked');
      else send(c.ws, { t: 'host.removed', hostId });
    }
  }

  function revokeDevice(deviceId) {
    const ok = db.revokeDevice(deviceId);
    for (const c of devices.get(deviceId) || []) c.ws.close(4003, 'revoked');
    return ok;
  }

  function sweep() {
    const cutoff = Date.now() - DEDUPE_MS;
    for (const [k, v] of dedupe) if (v.ts < cutoff && v.result) dedupe.delete(k);
    try { db.prune(); } catch {}
    // Changes made with the admin CLI (another process) land here: revoked
    // phones, removed or re-enrolled PCs, grants that went away.
    for (const [deviceId, set] of devices) {
      const dev = db.getDevice(deviceId);
      if (!dev || dev.revoked_at) {
        for (const c of set) c.ws.close(4003, 'revoked');
        continue;
      }
      const granted = new Set(db.grantsForDevice(deviceId).map((g) => g.hostId));
      for (const c of set) {
        for (const hostId of [...c.grants.keys()]) if (!granted.has(hostId)) dropGrant(deviceId, hostId);
      }
    }
    for (const [hostId, h] of hosts) {
      if (!h.ws) continue;
      const row = db.getHost(hostId);
      if (!row || !row.public_key) h.ws.close(4003, 'host removed or re-enrolled');
    }
  }
  const sweeper = setInterval(sweep, 60000);

  return {
    hostWss,
    deviceWss,
    revokeDevice,
    sweep, // runs every minute; exposed for tests
    // HTTP pairing lands here so live host state can be summarized.
    pair(token, name, platform) {
      const row = db.consumePairToken(token);
      if (!row) return null;
      const deviceId = db.addDevice(name, platform);
      db.upsertGrant(deviceId, row.host_id, row.scopes);
      db.audit({ deviceId, hostId: row.host_id, op: 'device.pair', args: { name, platform }, ok: true });
      const refreshToken = db.issueRefresh(deviceId);
      const access = issueAccess(db.tokenKey, deviceId, cfg.accessTtlMs);
      if (hostState(row.host_id).ws) send(hostState(row.host_id).ws, { t: 'devices', items: publicDevices(db.listDevices(row.host_id)) });
      return { deviceId, hostId: row.host_id, scopes: row.scopes.split(','), refreshToken, ...access };
    },
    // Joins an already-paired device to one more host (scan a second PC's QR).
    pairExisting(deviceId, token) {
      const row = db.consumePairToken(token);
      if (!row) return null;
      db.upsertGrant(deviceId, row.host_id, row.scopes);
      db.audit({ deviceId, hostId: row.host_id, op: 'device.pair', ok: true });
      for (const c of devices.get(deviceId) || []) c.ws.close(4000, 'grants changed, reconnect');
      return { deviceId, hostId: row.host_id, scopes: row.scopes.split(',') };
    },
    stats() {
      return { hostsOnline: [...hosts.values()].filter((h) => h.online).length, devicesOnline: devices.size };
    },
    close() {
      closing = true;
      clearInterval(sweeper);
      for (const h of hosts.values()) {
        clearTimeout(h.offlineTimer);
        for (const p of h.pendingCmds.values()) clearTimeout(p.timer);
      }
      for (const c of hostWss.clients) c.terminate();
      for (const c of deviceWss.clients) c.terminate();
    },
  };
}
