// Topics + cross-workspace routing + traffic stats, driven over HTTP without
// Electron (same style as test/bus.mjs). Run with: npm run test:topics
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topictest-'));
bus.start(dir, () => {});
await new Promise((r) => setTimeout(r, 200));
const { url, token } = bus.info();
console.log('bus at', url);

// ws1 has two agents, ws2 has two, ws3 has one.
const ROSTER = [
  { termId: 't1', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiFast', type: 'claude', status: 'idle' },
  { termId: 't2', spaceId: 'ws1', spaceName: 'Riverside', name: 'TermiEco', type: 'codex', status: 'idle' },
  { termId: 't3', spaceId: 'ws2', spaceName: 'Ocean Park', name: 'TermiUni', type: 'claude', status: 'idle' },
  { termId: 't4', spaceId: 'ws2', spaceName: 'Ocean Park', name: 'TermiPearl', type: 'claude', status: 'idle' },
  { termId: 't5', spaceId: 'ws3', spaceName: 'Skylake', name: 'TermiCity', type: 'claude', status: 'idle' },
];
bus.setRoster(ROSTER);

const call = (agent, method, route, body) =>
  fetch(url + route, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      'x-termivin-agent': agent,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

// --- create ---------------------------------------------------------------
const made = await call('t1', 'POST', '/topics', { name: 'deploys' });
check('topic create succeeds', made.status === 200 && made.json.topic.name === 'deploys', made.json);
check('creator becomes representative', made.json.topic.effectiveRepName === 'TermiFast', made.json.topic);

const dup = await call('t3', 'POST', '/topics', { name: 'Deploys' });
check('duplicate topic name (any case) is rejected', dup.status === 409, dup);

const withRep = await call('t3', 'POST', '/topics', { name: 'research', rep: 'TermiPearl' });
check('topic create with explicit rep', withRep.json.topic?.effectiveRepName === 'TermiPearl', withRep.json);

const badRep = await call('t1', 'POST', '/topics', { name: 'x', rep: 'TermiUni' });
check('rep must live in the same workspace', badRep.status === 404, badRep);

const listT = await call('t5', 'GET', '/topics');
check('topics list shows both topics', listT.json.topics.length === 2, listT.json);

// --- same-workspace: broadcast to everyone --------------------------------
const inSpace = await call('t2', 'POST', '/publish', { to: '#deploys', body: 'shipping v2' });
check('in-workspace topic send reaches the whole workspace',
  inSpace.json.delivered?.length === 1 && inSpace.json.delivered[0] === 'TermiFast', inSpace.json);
check('reply notes the topic', inSpace.json.topic === 'deploys', inSpace.json);

const t1got = await call('t1', 'GET', '/recv');
check('topic message carries topic name', t1got.json.messages[0]?.topic === 'deploys', t1got.json);

// --- cross-workspace: representative only ---------------------------------
const cross = await call('t3', 'POST', '/publish', { to: '#deploys', body: 'ws2 asking about deploys', kind: 'ask' });
check('cross-workspace topic send reaches only the representative',
  cross.json.delivered?.length === 1 && cross.json.delivered[0] === 'TermiFast', cross.json);

const t2got = await call('t2', 'GET', '/recv');
check('non-representative peers do not hear external topic mail', t2got.json.messages.length === 0, t2got.json);

const repGot = await call('t1', 'GET', '/recv');
check('representative receives the external message',
  repGot.json.messages.length === 1 && repGot.json.messages[0].body === 'ws2 asking about deploys', repGot.json);

// topic:name addressing form
const alt = await call('t5', 'POST', '/publish', { to: 'topic:deploys', body: 'ws3 here' });
check('topic:name addressing works', alt.json.delivered?.[0] === 'TermiFast', alt.json);
await call('t1', 'GET', '/recv');

// --- representative fallback ----------------------------------------------
// Drop t1 (the configured rep). t2 registers, so it becomes the stand-in.
await call('t2', 'POST', '/register', { role: 'release manager' });
bus.setRoster(ROSTER.filter((a) => a.termId !== 't1'));
const fb = await call('t3', 'POST', '/publish', { to: '#deploys', body: 'anyone home?' });
check('dead representative falls back to a live registered agent',
  fb.json.delivered?.[0] === 'TermiEco', fb.json);
bus.setRoster(ROSTER);

const none = await call('t1', 'POST', '/publish', { to: '#nope', body: 'x' });
check('unknown topic is a 404', none.status === 404, none);

// --- stats ----------------------------------------------------------------
const stats = bus.stats();
check('stats lists agents with traffic', stats.agents.find((a) => a.id === 't1')?.traffic.recv >= 2, stats.agents);
check('stats records links', stats.links.some((l) => l.from === 't3' && l.to === 't1' && l.count >= 1), stats.links);
check('stats records cross-space links', stats.spaceLinks.some((l) => l.from === 'ws2' && l.to === 'ws1'), stats.spaceLinks);
check('stats keeps recent messages with topic', stats.recent.some((m) => m.topic === 'deploys'), stats.recent.length);
check('stats lists topics', stats.topics.length === 2, stats.topics);

// --- persistence ----------------------------------------------------------
bus.stop();
await new Promise((r) => setTimeout(r, 100));
bus.start(dir, () => {});
await new Promise((r) => setTimeout(r, 200));
bus.setRoster(ROSTER);
const reStats = bus.stats();
check('topics survive a bus restart', reStats.topics.length === 2 && reStats.topics.some((t) => t.name === 'deploys'), reStats.topics);
check('registration survives a bus restart',
  reStats.agents.find((a) => a.id === 't2')?.registered === true, reStats.agents.find((a) => a.id === 't2'));
check('traffic links are rebuilt from the log on restart',
  reStats.links.some((l) => l.from === 't3' && l.to === 't1' && l.count >= 1), reStats.links);
check('cross-workspace links are rebuilt on restart',
  reStats.spaceLinks.some((l) => l.from === 'ws2' && l.to === 'ws1'), reStats.spaceLinks);
check('recent feed survives a restart',
  reStats.recent.length > 0 && reStats.recent.some((m) => m.topic === 'deploys'), reStats.recent.length);

// main-process management API
const created = bus.createTopic('ops', 'ws3', 't5');
check('createTopic from the app works', created.ok && created.topic.name === 'ops', created);
const renamed = bus.updateTopic(created.topic.id, { name: 'operations', repId: 't5' });
check('updateTopic renames', renamed.ok && renamed.topic.name === 'operations', renamed);
const removed = bus.deleteTopic(created.topic.id);
check('deleteTopic removes', removed.ok && bus.stats().topics.length === 2, removed);

// --- CLI ------------------------------------------------------------------
const { execFile } = await import('child_process');
const live = bus.info();
const cli = (agent, args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, TERMIVIN_URL: live.url, TERMIVIN_TOKEN: live.token, TERMIVIN_AGENT: agent },
    }, (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || '')));
  });

const cliTopic = await cli('t5', ['topic', 'alerts']);
check('CLI creates a topic', cliTopic.includes('Created topic #alerts'), cliTopic);
const cliTopics = await cli('t1', ['topics']);
check('CLI lists topics', cliTopics.includes('#alerts') && cliTopics.includes('#deploys'), cliTopics);
const cliSend = await cli('t1', ['send', '#alerts', 'disk is full']);
check('CLI sends to a topic cross-workspace', cliSend.includes('Sent to: TermiCity'), cliSend);
const cliRecv = await cli('t5', ['recv']);
check('CLI recv shows the topic message', cliRecv.includes('disk is full'), cliRecv);

bus.stop();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
