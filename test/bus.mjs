// End-to-end exercise of the agent bus (src/agent-bus.js + bin/termivin.js),
// driven over HTTP without Electron. Run with: npm run test:bus
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';
import fs from 'fs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUS_PATH = path.join(ROOT, 'src', 'agent-bus.js');
const CLI_PATH = path.join(ROOT, 'bin', 'termivin.js');
const require = createRequire(import.meta.url);
const bus = require(BUS_PATH);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bustest-'));
const events = [];
bus.start(dir, (e) => events.push(e));
await new Promise((r) => setTimeout(r, 200));
const { url, token } = bus.info();
console.log('bus at', url);

bus.setRoster([
  { termId: 't1', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiFast', type: 'claude', status: 'idle' },
  { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'codex', status: 'working' },
  { termId: 't3', spaceId: 'ws2', spaceName: 'Ocean Park', name: 'TermiUni', type: 'claude', status: 'idle' },
]);

const call = (agent, method, route, body, extraHeaders = {}) =>
  fetch(url + route, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      'x-termivin-agent': agent,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

// --- auth ---
const noTok = await fetch(url + '/agents', { headers: { 'x-termivin-agent': 't1' } });
check('rejects a missing token', noTok.status === 401, noTok.status);

const badTok = await fetch(url + '/agents', {
  headers: { authorization: 'Bearer ' + 'x'.repeat(48), 'x-termivin-agent': 't1' },
});
check('rejects a wrong token', badTok.status === 401, badTok.status);

const origin = await call('t1', 'GET', '/agents', null, { origin: 'https://evil.example' });
check('rejects a browser Origin', origin.status === 403, origin);

const unknown = await call('nope', 'GET', '/agents');
check('rejects an unknown agent id', unknown.status === 404, unknown);

// --- registry + workspace scoping ---
const reg = await call('t1', 'POST', '/register', { role: 'backend, owns src/api' });
check('register returns peers', reg.json.peers.length === 1 && reg.json.peers[0].name === 'TermiEco', reg.json);
check('register scopes to workspace', !JSON.stringify(reg.json.peers).includes('TermiUni'), reg.json.peers);

const list = await call('t1', 'GET', '/agents');
check('who shows live status', list.json.agents.find((a) => a.name === 'TermiEco').status === 'working', list.json);
check('who echoes the role back', list.json.me.role === 'backend, owns src/api', list.json.me);

// --- messaging ---
const sent = await call('t1', 'POST', '/publish', { to: 'TermiEco', body: 'schema for users?', kind: 'ask' });
check('send resolves by name', sent.json.delivered?.[0] === 'TermiEco', sent.json);

const crossWs = await call('t1', 'POST', '/publish', { to: 'TermiUni', body: 'hi' });
check('cannot message another workspace', crossWs.status === 404, crossWs);

const got = await call('t2', 'GET', '/recv');
check('recv delivers the message', got.json.messages.length === 1 && got.json.messages[0].body === 'schema for users?', got.json);
check('message carries sender name', got.json.messages[0].fromName === 'TermiFast', got.json.messages[0]);

const empty = await call('t2', 'GET', '/recv');
check('recv drains the queue', empty.json.messages.length === 0, empty.json);

// --- long-poll ---
const t0 = Date.now();
const pollPromise = call('t2', 'GET', '/recv?wait=10');
await new Promise((r) => setTimeout(r, 300));
await call('t1', 'POST', '/publish', { to: 'TermiEco', body: 'late answer' });
const polled = await pollPromise;
const elapsed = Date.now() - t0;
check('long-poll wakes on delivery', polled.json.messages[0]?.body === 'late answer', polled.json);
check('long-poll returns promptly (' + elapsed + 'ms)', elapsed < 3000, elapsed);

const capped = await call('t2', 'GET', '/recv?wait=999');
check('long-poll wait is capped at 60s', capped.status === 200, capped.status);

// --- broadcast ---
bus.setRoster([
  { termId: 't1', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiFast', type: 'claude', status: 'idle' },
  { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'codex', status: 'idle' },
  { termId: 't4', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiPearl', type: 'claude', status: 'idle' },
]);
const bcast = await call('t1', 'POST', '/publish', { to: '@all', body: 'deploying now' });
check('broadcast hits every peer but self', bcast.json.delivered.length === 2, bcast.json);
const b2 = await call('t2', 'GET', '/recv');
check('broadcast is flagged', b2.json.messages[0]?.broadcast === true, b2.json.messages[0]);

// --- rate limit ---
let limited = false;
for (let i = 0; i < 25; i++) {
  const r = await call('t1', 'POST', '/publish', { to: 'TermiEco', body: 'spam ' + i });
  if (r.status === 429) { limited = true; break; }
}
check('rate limit kicks in', limited, 'never limited');

// --- persistence across a real restart ---
await call('t4', 'GET', '/recv'); // t4 reads its broadcast, so the queue is clean
// t1 is rate-limited by now; send from t2 instead.
await call('t2', 'POST', '/publish', { to: 'TermiPearl', body: 'unread on restart' });
check('pre-restart: one unread for t4', bus.pendingCount('t4') === 1, bus.pendingCount('t4'));
bus.stop();
await new Promise((r) => setTimeout(r, 100));

// A genuine restart is a fresh process — re-require would hit the module cache.
const { execFileSync } = await import('child_process');
// Roster is empty in the probe, so read the queues through a debug hook: the
// bus exposes counts, and the log tells us which bodies came back.
const probe = `
  const b = require(${JSON.stringify(BUS_PATH)});
  b.start(${JSON.stringify(dir)}, () => {});
  b.setRoster([
    { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'codex', status: 'idle' },
    { termId: 't4', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiPearl', type: 'claude', status: 'idle' },
  ]);
  setTimeout(async () => {
    const { url, token } = b.info();
    const get = (agent) => fetch(url + '/recv', {
      headers: { authorization: 'Bearer ' + token, 'x-termivin-agent': agent },
    }).then((r) => r.json());
    console.log(JSON.stringify({
      t4: (await get('t4')).messages.map((m) => m.body),
      t2: (await get('t2')).messages.map((m) => m.body),
    }));
    process.exit(0);
  }, 300);
`;
const replayed = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }));
check('restart replays the unread message', replayed.t4.join() === 'unread on restart', replayed.t4);
// t2 never read the rate-limit spam, so those should come back — but the three
// messages it *did* read must not.
const readBefore = ['schema for users?', 'late answer', 'deploying now'];
check('restart does not resurrect read messages',
  !replayed.t2.some((b) => readBefore.includes(b)),
  replayed.t2.filter((b) => readBefore.includes(b)));
check('restart keeps genuinely unread messages',
  replayed.t2.length > 0 && replayed.t2.every((b) => b.startsWith('spam ')), replayed.t2.slice(0, 3));

const logged = fs.readFileSync(path.join(dir, 'bus', 'ws1.jsonl'), 'utf8').trim().split('\n');
const msgRecords = logged.filter((l) => JSON.parse(l).t === 'msg');
check('messages are persisted to the log', msgRecords.length > 0, msgRecords.length);
check('log records deliveries too', logged.some((l) => JSON.parse(l).t === 'deliver'), 'no deliver record');

// --- the CLI an agent actually runs ---------------------------------------
// Everything above spoke HTTP directly; this checks bin/termivin.js end to end
// with the same environment src/main.js injects into a spawned terminal.
bus.start(dir, () => {});
await new Promise((r) => setTimeout(r, 200));
const live = bus.info();
bus.setRoster([
  { termId: 't1', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiFast', type: 'claude', status: 'idle' },
  { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'codex', status: 'working' },
]);

// Must be async: the bus lives in *this* process, so a synchronous spawn would
// block the event loop and deadlock against the child's own request.
const { execFile } = await import('child_process');
const cli = (agent, args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, TERMIVIN_URL: live.url, TERMIVIN_TOKEN: live.token, TERMIVIN_AGENT: agent },
      },
      (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || ''))
    );
  });

const cliReg = await cli('t1', ['register', '--role', 'backend, owns src/api']);
check('CLI register succeeds', cliReg.includes('Registered as "TermiFast"'), cliReg);
check('CLI register lists peers', cliReg.includes('TermiEco'), cliReg);

const cliWho = await cli('t2', ['who']);
check('CLI who shows roles', cliWho.includes('backend, owns src/api'), cliWho);
check('CLI who marks self', cliWho.includes('← you'), cliWho);

const cliSend = await cli('t2', ['send', 'TermiFast', 'ping from the CLI', '--ask']);
check('CLI send reports the recipient', cliSend.includes('Sent to: TermiFast'), cliSend);

const cliRecv = await cli('t1', ['recv']);
check('CLI recv prints the message', cliRecv.includes('ping from the CLI'), cliRecv);
check('CLI recv flags a question', cliRecv.includes('needs a reply'), cliRecv);

const cliBad = await cli('t1', ['send', 'NoSuchAgent', 'hello']);
check('CLI reports an unknown recipient', cliBad.includes('no such agent'), cliBad);

// A shell outside Termivin should get an explanation, not a stack trace.
let orphan = '';
try {
  execFileSync(process.execPath, [CLI_PATH, 'who'], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, TERMIVIN_URL: '', TERMIVIN_TOKEN: '', TERMIVIN_AGENT: '', APPDATA: dir },
  });
} catch (err) {
  orphan = String(err.stdout || '') + String(err.stderr || '');
}
check('CLI outside Termivin explains itself',
  orphan.includes('Not running inside a Termivin terminal'), orphan);

bus.stop();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
