// End-to-end tests for the relay: real HTTP + WebSocket on an ephemeral port,
// a fake host (Ed25519 key, like the desktop) and fake phones.
//   npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { parseHostFrame } from '../src/relay.js';

let srv;
let base;
let wsBase;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));

before(async () => {
  const cfg = { ...loadConfig({ RELAY_DATA_DIR: dataDir, RELAY_PORT: '0', RELAY_BIND: '127.0.0.1', RELAY_PUBLIC_URL: 'http://relay.test' }) };
  srv = await startServer(cfg, { log: () => {} });
  base = `http://127.0.0.1:${srv.port}`;
  wsBase = `ws://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

// A socket with a message queue, so tests can await "the next message of type X".
function client(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  const frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      frames.push(Buffer.from(data));
      return;
    }
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i !== -1) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return {
    ws, frames, closed,
    open: () => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred, ms = 3000) {
      const p = typeof pred === 'string' ? (m) => m.t === pred : pred;
      const i = queue.findIndex(p);
      if (i !== -1) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred: p, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k !== -1) { waiters.splice(k, 1); reject(new Error('timeout waiting for message')); }
        }, ms);
      });
    },
  };
}

function hostKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, publicKeyB64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

async function enrolledHost(name = 'Office PC') {
  const { id, code } = srv.db.addHost(name);
  const key = hostKey();
  const r = await post('/api/hosts/enroll', { code, publicKey: key.publicKeyB64, name });
  assert.equal(r.status, 200);
  assert.equal(r.json.hostId, id);
  return { id, key };
}

async function connectHost(h) {
  const c = client(`${wsBase}/ws/host`);
  await c.open();
  const { nonce } = await c.next('challenge');
  c.send({ t: 'auth', hostId: h.id, sig: crypto.sign(null, Buffer.from(nonce), h.key.privateKey).toString('base64') });
  await c.next('ready');
  return c;
}

async function pairPhone(host, scopes = ['view', 'approve', 'input', 'manage']) {
  host.send({ t: 'pair.create', scopes });
  const { token, url } = await host.next('pair.created');
  assert.equal(url, 'http://relay.test');
  const r = await post('/api/devices/pair', { token, name: 'Pixel', platform: 'android' });
  assert.equal(r.status, 200);
  return r.json;
}

async function connectPhone(accessToken) {
  const c = client(`${wsBase}/ws/device`);
  await c.open();
  c.send({ t: 'auth', token: accessToken });
  const ready = await c.next('ready');
  return { c, ready };
}

test('enrollment codes are single use and hosts must sign the challenge', async () => {
  const { code } = srv.db.addHost('Laptop');
  const k = hostKey();
  assert.equal((await post('/api/hosts/enroll', { code, publicKey: k.publicKeyB64 })).status, 200);
  assert.equal((await post('/api/hosts/enroll', { code, publicKey: k.publicKeyB64 })).status, 403);
  assert.equal((await post('/api/hosts/enroll', { code: 'nope', publicKey: 'garbage' })).status, 400);

  const h = await enrolledHost();
  const bad = client(`${wsBase}/ws/host`);
  await bad.open();
  await bad.next('challenge');
  bad.send({ t: 'auth', hostId: h.id, sig: Buffer.alloc(64).toString('base64') });
  assert.equal(await bad.closed, 4003);
});

test('pairing, snapshot fan-out, stale cache and offline rejection', async () => {
  const h = await enrolledHost();
  const host = await connectHost(h);
  const paired = await pairPhone(host);
  assert.ok(paired.refreshToken && paired.accessToken);
  assert.deepEqual(paired.scopes, ['view', 'approve', 'input', 'manage']);

  // pairing tokens are single use
  host.send({ t: 'pair.create', scopes: ['view'] });
  const { token } = await host.next('pair.created');
  assert.equal((await post('/api/devices/pair', { token })).status, 200);
  assert.equal((await post('/api/devices/pair', { token })).status, 403);

  const { c: phone, ready } = await connectPhone(paired.accessToken);
  assert.equal(ready.hosts.find((x) => x.hostId === h.id).online, true);

  host.send({ t: 'snapshot', data: { workspaces: [{ id: 'ws1', name: 'Riverside' }] } });
  const snap = await phone.next('snapshot');
  assert.equal(snap.data.workspaces[0].name, 'Riverside');
  assert.equal(snap.stale, false);

  host.send({ t: 'attention', items: [{ id: 'a1', kind: 'approval', termId: 't1', title: 'TermiFast', excerpt: 'npm test' }] });
  assert.equal((await phone.next((m) => m.t === 'attention' && m.items.length)).items[0].id, 'a1');

  host.ws.close();
  const off = await phone.next((m) => m.t === 'host' && m.online === false);
  assert.ok(off.lastSeen);

  phone.send({ t: 'cmd', id: 'c-off', hostId: h.id, op: 'term.keys', args: { termId: 't1', keys: 'enter' } });
  const rejected = await phone.next('cmd.result');
  assert.equal(rejected.error, 'host_offline');

  // a phone connecting while the PC is away still sees the last state, flagged stale
  const { c: late } = await connectPhone(paired.accessToken);
  const cached = await late.next('snapshot');
  assert.equal(cached.stale, true);
  assert.equal((await late.next((m) => m.t === 'attention' && m.items.length)).items.length, 1);
  phone.ws.close();
  late.ws.close();
});

test('commands: scope check, forwarding, dedupe, audit', async () => {
  const h = await enrolledHost();
  const host = await connectHost(h);
  const viewer = await pairPhone(host, ['view']);
  const admin = await pairPhone(host);
  const { c: v } = await connectPhone(viewer.accessToken);
  const { c: a } = await connectPhone(admin.accessToken);

  v.send({ t: 'cmd', id: 'x1', hostId: h.id, op: 'approval.answer', args: {} });
  assert.equal((await v.next('cmd.result')).error, 'forbidden');
  v.send({ t: 'cmd', id: 'x2', hostId: h.id, op: 'rm -rf', args: {} });
  assert.equal((await v.next('cmd.result')).error, 'unknown_op');

  a.send({ t: 'cmd', id: 'k1', hostId: h.id, op: 'term.input', args: { termId: 't1', data: 'secret text' } });
  const fwd = await host.next('cmd');
  assert.equal(fwd.op, 'term.input');
  assert.equal(fwd.deviceId, admin.deviceId);
  // same id again while in flight: answered once, not forwarded twice
  a.send({ t: 'cmd', id: 'k1', hostId: h.id, op: 'term.input', args: { termId: 't1', data: 'secret text' } });
  host.send({ t: 'cmd.result', id: fwd.id, ok: true, data: { n: 1 } });
  const r1 = await a.next('cmd.result');
  const r2 = await a.next('cmd.result');
  assert.deepEqual([r1.ok, r2.ok, r1.id, r2.id], [true, true, 'k1', 'k1']);
  await assert.rejects(host.next('cmd', 300));

  const audit = srv.db.listAudit({ hostId: h.id });
  const entry = audit.find((r) => r.op === 'term.input');
  assert.equal(entry.ok, 1);
  assert.ok(!entry.args.includes('secret text'), 'free input is not logged verbatim');

  a.send({ t: 'cmd', id: 'q1', hostId: h.id, op: 'relay.devices', args: {} });
  const list = await a.next('cmd.result');
  assert.equal(list.data.length, 2);
  v.ws.close();
  a.ws.close();
  host.ws.close();
});

test('PTY streaming: subscribe, binary frames routed per terminal, unsubscribe', async () => {
  const h = await enrolledHost();
  const host = await connectHost(h);
  const paired = await pairPhone(host);
  const { c: p1 } = await connectPhone(paired.accessToken);
  const { c: p2 } = await connectPhone(paired.accessToken);

  p1.send({ t: 'sub', hostId: h.id, termId: 't1', lastSeq: 5 });
  const sub = await host.next('sub');
  assert.deepEqual([sub.termId, sub.lastSeq, sub.first], ['t1', 5, true]);
  p2.send({ t: 'sub', hostId: h.id, termId: 't1' });
  assert.equal((await host.next('sub')).first, false);

  const tid = Buffer.from('t1');
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(42);
  host.ws.send(Buffer.concat([Buffer.from([tid.length]), tid, seq, Buffer.from('hello')]), { binary: true });
  // a frame for a terminal nobody watches goes nowhere
  const other = Buffer.from('t9');
  host.ws.send(Buffer.concat([Buffer.from([other.length]), other, seq, Buffer.from('nope')]), { binary: true });
  await new Promise((r) => setTimeout(r, 200));
  for (const p of [p1, p2]) {
    assert.equal(p.frames.length, 1);
    const f = p.frames[0];
    const hl = f[0];
    assert.equal(f.subarray(1, 1 + hl).toString(), h.id);
    const inner = parseHostFrame(f.subarray(1 + hl));
    assert.equal(inner.termId, 't1');
    assert.equal(inner.rest.readUInt32BE(0), 42);
    assert.equal(inner.rest.subarray(4).toString(), 'hello');
  }

  host.send({ t: 'event', kind: 'screen', data: { termId: 't1', seq: 42, data: 'SCREEN' } });
  assert.equal((await p1.next((m) => m.kind === 'screen')).data.data, 'SCREEN');

  p1.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(host.next('unsub', 200));
  p2.send({ t: 'unsub', hostId: h.id, termId: 't1' });
  assert.equal((await host.next('unsub')).termId, 't1');
  p2.ws.close();
  host.ws.close();
});

test('refresh rotation and revocation', async () => {
  const h = await enrolledHost();
  const host = await connectHost(h);
  const paired = await pairPhone(host);

  const r1 = await post('/api/token/refresh', { refreshToken: paired.refreshToken });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refreshToken, paired.refreshToken);
  assert.equal((await post('/api/token/refresh', { refreshToken: paired.refreshToken })).status, 401, 'old refresh token is spent');

  const { c: phone } = await connectPhone(r1.json.accessToken);
  host.send({ t: 'devices.revoke', deviceId: paired.deviceId });
  assert.equal(await phone.closed, 4003);
  assert.equal((await post('/api/token/refresh', { refreshToken: r1.json.refreshToken })).status, 200,
    'revoking one host grant keeps the device');
  srv.relay.revokeDevice(paired.deviceId);
  assert.equal((await post('/api/token/refresh', { refreshToken: r1.json.refreshToken })).status, 401);
  host.ws.close();
});

test('bad access tokens are refused', async () => {
  const c = client(`${wsBase}/ws/device`);
  await c.open();
  c.send({ t: 'auth', token: 'abc.def' });
  assert.equal(await c.closed, 4003);
});
