// Integration test: desktop remote controller (src/remote) ⇄ real relay
// (server/) ⇄ a fake phone — all in one Node process, no Electron.
//   node test/remote.mjs
// Needs `npm install` in server/ (for the relay and its ws client).

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Hub } = require('../src/hub.js');
const bus = require('../src/agent-bus.js');
const { createRemote } = require('../src/remote/index.js');
const { startServer } = await import(pathToFileURL(path.join(root, 'server/src/server.js')).href);
const { loadConfig } = await import(pathToFileURL(path.join(root, 'server/src/config.js')).href);
const WebSocket = createRequire(path.join(root, 'server/package.json'))('ws');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail).slice(0, 400)));
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(30);
  }
  return fn();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termivin-remote-'));
const relay = await startServer(loadConfig({ RELAY_DATA_DIR: path.join(tmp, 'relay'), RELAY_PORT: '0', RELAY_BIND: '127.0.0.1' }), { log: () => {} });
const relayUrl = `http://127.0.0.1:${relay.port}`;

// --- desktop side ------------------------------------------------------------
const userData = path.join(tmp, 'desktop');
fs.mkdirSync(userData, { recursive: true });
const hub = new Hub();
await hub.ready;
let remote;
bus.start(userData, (evt) => remote && remote.onBusEvent(evt));
await sleep(150);

class FakePty {
  constructor() { this.written = []; this.pid = 1234; }
  write(d) { this.written.push(d); }
  get text() { return this.written.join(''); }
}
const ptys = new Map([['t1', new FakePty()], ['t2', new FakePty()]]);
const rendererCalls = [];
remote = createRemote({
  userData, hub, bus, ptys,
  invokeRenderer: async (op, args) => { rendererCalls.push({ op, args }); return { ok: 1 }; },
  recentProjects: () => ['/work/api'],
  platform: process.platform, version: 'test',
  notifyRenderer: () => {},
  captureScreen: async () => PNG_1PX,
});
const state = {
  activeWorkspaceId: 'ws1',
  workspaces: [{
    id: 'ws1', name: 'Riverside',
    terminals: [
      { id: 't1', name: 'TermiFast', type: 'claude', cwd: path.join(tmp, 'nowhere'), command: 'claude', restoreCommand: 'claude --continue --permission-mode auto' },
      { id: 't2', name: 'TermiEco', type: 'shell', cwd: tmp, command: '', restoreCommand: '' },
    ],
  }],
};
remote.setState(state);
bus.setRoster([
  { termId: 't1', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiFast', type: 'claude', status: 'idle' },
  { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'shell', status: 'idle' },
]);
hub.start('t1', { cols: 70, rows: 16, pid: 1 });
hub.start('t2', { cols: 70, rows: 16, pid: 2 });

// enroll this "PC"
const { code } = relay.db.addHost('Test PC');
const enrolled = await remote.link.enroll({ url: relayUrl, code, name: 'Test PC' });
check('desktop enrolls with a code', !!enrolled.hostId);
await until(() => remote.link.online);
check('desktop connects out to the relay', remote.link.online);

// pair a phone
const pairing = await remote.link.createPairing(['view', 'approve', 'input', 'manage']);
const paired = await fetch(relayUrl + '/api/devices/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: pairing.token, name: 'Pixel test', platform: 'android' }),
}).then((r) => r.json());
check('phone pairs with the desktop pairing token', !!paired.accessToken, paired);

// --- phone side --------------------------------------------------------------
const phone = new WebSocket(relayUrl.replace('http', 'ws') + '/ws/device');
const inbox = [];
const frames = [];
phone.on('message', (d, bin) => (bin ? frames.push(Buffer.from(d)) : inbox.push(JSON.parse(d.toString()))));
await new Promise((r) => phone.once('open', r));
phone.send(JSON.stringify({ t: 'auth', token: paired.accessToken }));
const ready = await until(() => inbox.find((m) => m.t === 'ready'));
check('phone sees the PC online', ready && ready.hosts[0].online && ready.hosts[0].name === 'Test PC', ready);
const hostId = ready.hosts[0].hostId;

let cmdSeq = 0;
async function cmd(op, args) {
  const id = 'c' + ++cmdSeq;
  phone.send(JSON.stringify({ t: 'cmd', id, hostId, op, args }));
  return until(() => inbox.find((m) => m.t === 'cmd.result' && m.id === id), 6000);
}

const snap = await until(() => inbox.filter((m) => m.t === 'snapshot').pop());
const terms = snap && snap.data.workspaces[0].terminals;
check('snapshot lists workspace and terminals', terms && terms.map((t) => t.name).join() === 'TermiFast,TermiEco', snap);
check('snapshot carries permission mode', terms && terms[0].permissionMode === 'auto');

// approval: the prompt appears on the desktop, the phone answers it
hub.data('t1', [
  '╭──────────────────────────────╮',
  '│ Bash command                 │',
  '│   npm run migrate            │',
  '│ Do you want to proceed?      │',
  '│ ❯ 1. Yes                     │',
  '│   2. No                      │',
  '╰──────────────────────────────╯',
].join('\r\n') + '\r\n');
const att = await until(() => inbox.filter((m) => m.t === 'attention' && m.items.length).pop());
const item = att && att.items[0];
check('phone inbox gets the approval', item && item.kind === 'approval' && item.excerpt.includes('npm run migrate') && item.options.length === 2, att);

const stale = await cmd('approval.answer', { termId: 't1', approvalId: item.id, screenHash: 'ffffffff', option: '1' });
check('an answer for a prompt no longer on screen is refused', !stale.ok && stale.error === 'prompt_changed', stale);
check('nothing was typed for the refused answer', ptys.get('t1').text === '');
const ans = await cmd('approval.answer', { termId: 't1', approvalId: item.id, screenHash: item.screenHash, option: '1', label: 'Yes' });
check('matching answer is accepted', ans.ok, ans);
check('the option key reached the PTY', ptys.get('t1').text === '1', ptys.get('t1').text);

// quick keys vs free input scopes
const keys = await cmd('term.keys', { termId: 't1', keys: ['esc'] });
check('quick keys are typed', keys.ok && ptys.get('t1').text.endsWith('\x1b'));
const badKey = await cmd('term.keys', { termId: 't1', keys: ['rm -rf /'] });
check('arbitrary text is not a quick key', !badKey.ok);

// live terminal view: screen first, then binary frames
phone.send(JSON.stringify({ t: 'sub', hostId, termId: 't2' }));
hub.data('t2', 'PS C:\\> ');
const screen = await until(() => inbox.find((m) => m.t === 'event' && m.kind === 'screen' && m.data.termId === 't2'));
check('subscribing sends the current screen', screen && typeof screen.data.data === 'string' && Number.isInteger(screen.data.seq), screen);
hub.data('t2', 'dir\r\n');
await until(() => frames.length);
const f = frames[frames.length - 1];
const hl = f[0];
const tl = f[1 + hl];
check('live output streams as binary frames', f.subarray(2 + hl + tl + 4).toString() === 'dir\r\n');

// chat: prompt mode when idle, queued when busy
await sleep(3200); // let t1 go idle
check('t1 is idle', hub.status('t1') === 'idle', hub.status('t1'));
ptys.get('t1').written = [];
const sent = await cmd('chat.send', { conv: 'dm:t1', text: 'please run the tests', mode: 'prompt' });
check('chat message to an idle agent is typed as a prompt', sent.ok && sent.data.state === 'delivered', sent);
await sleep(250);
check('prompt text then Enter reached the PTY', ptys.get('t1').text === 'please run the tests\r', ptys.get('t1').text);
hub.data('t1', 'working on it…\r\n');
const queued = await cmd('chat.send', { conv: 'dm:t1', text: 'also update the docs' });
check('chat message to a busy agent is queued', queued.ok && queued.data.state === 'queued', queued);
await sleep(3600);
check('queued prompt is delivered when the agent goes idle', ptys.get('t1').text.includes('also update the docs'), ptys.get('t1').text);
const delivered = inbox.find((m) => m.t === 'event' && m.kind === 'chat' && m.data.msg.id === queued.data.id && m.data.msg.state === 'delivered');
check('phone is told the queued message was delivered', !!delivered);

// the agent writes back to the owner over the bus
await fetch(bus.info().url + '/publish', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + bus.agentToken('t1'), 'x-termivin-agent': 't1', 'content-type': 'application/json' },
  body: JSON.stringify({ to: 'owner', body: 'tests are green ✅' }),
});
const reply = await until(() => inbox.find((m) => m.t === 'event' && m.kind === 'chat' && m.data.msg.text === 'tests are green ✅'));
check('agent → owner message arrives in the DM', reply && reply.data.conv === 'dm:t1' && reply.data.msg.fromName === 'TermiFast', reply);

const group = await cmd('chat.send', { conv: 'ws:ws1', text: 'stand-up in 5' });
check('group message goes to every agent in the workspace', group.ok && group.data.delivered.length === 2, group);

const list = await cmd('chat.list', {});
const dm = list.data.find((c) => c.conv === 'dm:t1');
check('chat list has the group and one DM per terminal', list.data.filter((c) => c.kind === 'group').length === 1 && list.data.filter((c) => c.kind === 'dm').length === 2);
check('DM shows the last message and unread count', dm.last && dm.unread >= 1, dm);
const hist = await cmd('chat.history', { conv: 'dm:t1', limit: 10 });
check('history returns the conversation in order', hist.ok && hist.data.map((m) => m.text).includes('please run the tests') && hist.data.at(-1).text === 'tests are green ✅', hist.data.map((m) => m.text));

// a command sent to a shell comes back as ONE summary with its output
await sleep(3200); // t2 idle
const shellSend = await cmd('chat.send', { conv: 'dm:t2', text: 'npm test', mode: 'prompt' });
check('command to an idle shell is typed', shellSend.ok && shellSend.data.state === 'delivered', shellSend);
const progress = await until(() => inbox.find((m) => m.t === 'event' && m.kind === 'progress' && m.data.termId === 't2' && m.data.active));
check('phone sees live progress while it runs', !!progress);
hub.data('t2', 'npm test\r\n\x1b[32m✓\x1b[0m 42 passing (3s)\r\nPS C:\\> ');
const shellSummary = await until(() => inbox.find((m) => m.t === 'event' && m.kind === 'chat' && m.data.conv === 'dm:t2' && m.data.msg.kind === 'summary'), 8000);
check('the finished command posts one summary with its output', shellSummary && shellSummary.data.msg.text === '✓ 42 passing (3s)', shellSummary && shellSummary.data.msg);
check('progress is cleared when it finishes', !!inbox.find((m) => m.t === 'event' && m.kind === 'progress' && m.data.termId === 't2' && !m.data.active));
check('raw output is not posted as chat messages', inbox.filter((m) => m.t === 'event' && m.kind === 'chat' && m.data.conv === 'dm:t2' && m.data.msg.role === 'agent').length === 1);

// an agent sends the owner a screenshot; the phone downloads it in chunks
const shotFile = path.join(tmp, 'preview.png');
fs.writeFileSync(shotFile, PNG_1PX);
const shotSent = await fetch(bus.info().url + '/publish', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + bus.agentToken('t1'), 'x-termivin-agent': 't1', 'content-type': 'application/json' },
  body: JSON.stringify({ to: 'owner', body: 'here is the login page', image: shotFile }),
}).then((r) => r.json());
check('agent can send an image to the owner', shotSent.ok, shotSent);
const imgMsg = await until(() => inbox.find((m) => m.t === 'event' && m.kind === 'chat' && m.data.msg.kind === 'image'));
check('phone gets an image message with its caption', imgMsg && imgMsg.data.conv === 'dm:t1' && imgMsg.data.msg.text === 'here is the login page' && imgMsg.data.msg.media.mime === 'image/png', imgMsg && imgMsg.data.msg);
const chunk = await cmd('media.get', { id: imgMsg.data.msg.media.id, offset: 0 });
check('phone downloads the image over the relay', chunk.ok && Buffer.from(chunk.data.data, 'base64').equals(PNG_1PX) && chunk.data.done, chunk);
const cap = await cmd('screen.capture', { conv: 'dm:t1' });
check('owner can capture the PC screen into a chat', cap.ok && cap.data.media.mime === 'image/png', cap);

// model changes go to the renderer
const r = await cmd('term.restart', { termId: 't1' });
check('restart is handed to the renderer', r.ok && rendererCalls.at(-1).op === 'term.restart');

// the PC goes away: phone sees it offline and commands are refused
remote.link.disconnect();
const off = await until(() => inbox.find((m) => m.t === 'host' && m.online === false));
check('phone sees the PC go offline', !!off);
const refused = await cmd('term.keys', { termId: 't1', keys: ['enter'] });
check('commands while offline are refused, not queued', !refused.ok && refused.error === 'host_offline', refused);

phone.close();
remote.stop();
bus.stop();
await relay.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nREMOTE: ${failures} FAILURE(S)` : '\nREMOTE: ALL PASSED');
process.exit(failures ? 1 : 0);
