// Client half of the agent bus — the `termivin register|who|send|recv`
// subcommands an agent runs from its shell. Credentials come from the env that
// src/main.js injects into every spawned terminal, so there is nothing to
// configure. Falls back to <userData>/bus.json for terminals that were already
// running when the app restarted.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function userDataDir() {
  // Must match app.getPath('userData'), which Electron derives from
  // package.json's productName — "Termivin", not the package name. Only APFS's
  // case-insensitivity hid the mismatch on macOS.
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Termivin');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Termivin');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Termivin');
}

function credentials() {
  let url = process.env.TERMIVIN_URL;
  let token = process.env.TERMIVIN_TOKEN;
  if (!url || !token) {
    // The app was restarted after this terminal spawned: the env still holds
    // the old port/token, so re-read the file the server writes on start.
    try {
      const f = JSON.parse(fs.readFileSync(path.join(userDataDir(), 'bus.json'), 'utf8'));
      url = f.url;
      token = f.token;
    } catch {}
  }
  const agent = process.env.TERMIVIN_AGENT;
  if (!url || !token || !agent) {
    throw new Error(
      'Not running inside a Termivin terminal (TERMIVIN_URL / TERMIVIN_AGENT are unset).\n' +
      'Open this shell as a terminal inside the Termivin app to use the agent bus.'
    );
  }
  return { url, token, agent };
}

function request(method, route, body, timeoutMs) {
  const { url, token, agent } = credentials();
  const target = new URL(route, url);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: {
          authorization: 'Bearer ' + token,
          'x-termivin-agent': agent,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
        // A long-poll must outlive its own wait window.
        timeout: timeoutMs || 15000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = { error: raw }; }
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('bus timed out — is the Termivin app still running?')));
    req.on('error', (err) => reject(new Error(
      err.code === 'ECONNREFUSED' ? 'cannot reach the Termivin app (is it closed?)' : err.message
    )));
    if (payload) req.write(payload);
    req.end();
  });
}

// --- output helpers -------------------------------------------------------

function renderAgent(a) {
  const bits = [a.name.padEnd(12), (a.status || '?').padEnd(9)];
  if (a.role) bits.push(a.role);
  else bits.push(a.registered ? '(no role set)' : '(not registered)');
  return '  ' + bits.join(' ');
}

function renderMessage(m) {
  const when = new Date(m.ts).toLocaleTimeString();
  const tag = m.kind === 'ask' ? ' [needs a reply]' : m.broadcast ? ' [broadcast]' : '';
  const head = `[${when}] from ${m.fromName}${tag}` + (m.subject ? ` — ${m.subject}` : '');
  const foot = m.kind === 'ask'
    ? `\n  ↳ reply with: termivin send ${m.fromName} "..." --corr ${m.corr || m.id}`
    : '';
  return `${head}\n${m.body.split('\n').map((l) => '  ' + l).join('\n')}${foot}`;
}

// --- subcommands ----------------------------------------------------------

function flag(argv, name, fallback) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] != null ? argv[i + 1] : fallback;
}

async function register(argv) {
  const role = flag(argv, 'role', null);
  const skills = flag(argv, 'skills', '');
  const res = await request('POST', '/register', {
    role,
    skills: skills ? skills.split(',').map((s) => s.trim()).filter(Boolean) : [],
    cwd: process.cwd(),
  });
  console.log(`Registered as "${res.me.name}" in workspace "${res.me.spaceName}".`);
  if (!res.peers.length) {
    console.log('No other agents here yet.');
  } else {
    console.log(`\n${res.peers.length} other agent(s):`);
    for (const p of res.peers) console.log(renderAgent(p));
  }
  console.log('\nNext: `termivin send <name> "..."` to talk, `termivin recv --wait 60` to listen.');
  return 0;
}

async function who() {
  const res = await request('GET', '/agents');
  console.log(`Workspace "${res.me.spaceName}" — you are "${res.me.name}"\n`);
  for (const a of res.agents) console.log(renderAgent(a) + (a.id === res.me.id ? '  ← you' : ''));
  return 0;
}

async function send(argv) {
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    positional.push(argv[i]);
  }
  const [to, ...rest] = positional;
  const text = rest.join(' ');
  if (!to || !text) {
    console.error('Usage: termivin send <agent-name|@all|#topic> "message" [--ask] [--subject S]');
    return 1;
  }
  const res = await request('POST', '/publish', {
    to,
    body: text,
    kind: argv.includes('--ask') ? 'ask' : flag(argv, 'kind', 'note'),
    subject: flag(argv, 'subject', ''),
    corr: flag(argv, 'corr', null),
  });
  console.log(`Sent to: ${res.delivered.join(', ')}` + (res.topic ? ` (topic #${res.topic})` : ''));
  if (argv.includes('--ask')) {
    console.log('This was a question. Replies arrive via `termivin recv` — keep working meanwhile.');
  }
  return 0;
}

function renderTopic(t) {
  const rep = t.effectiveRepName || '(no live agent)';
  const own = t.repName && t.repName !== t.effectiveRepName ? ` (configured: ${t.repName})` : '';
  return `  #${t.name.padEnd(18)} workspace "${t.spaceName || '?'}" · ${t.members} agent(s) · rep: ${rep}${own}`;
}

async function topicsCmd() {
  const res = await request('GET', '/topics');
  if (!res.topics.length) {
    console.log('No topics yet. Create one with: termivin topic <name>');
    return 0;
  }
  console.log('Topics (send with: termivin send "#<name>" "..."):\n');
  for (const t of res.topics) console.log(renderTopic(t));
  console.log('\nInside the topic\'s workspace a message reaches every agent;');
  console.log('from other workspaces it reaches only the representative.');
  return 0;
}

async function topicCmd(argv) {
  const name = argv[1];
  if (!name || name.startsWith('--')) {
    console.error('Usage: termivin topic <name> [--rep <agent-name>]   (creates a topic in this workspace)');
    return 1;
  }
  const res = await request('POST', '/topics', { name, rep: flag(argv, 'rep', null) });
  const t = res.topic;
  console.log(`Created topic #${t.name} in workspace "${t.spaceName}".`);
  console.log(`Representative (speaks for this workspace to the outside): ${t.effectiveRepName}.`);
  console.log(`Agents in other workspaces can reach it with: termivin send "#${t.name}" "..."`);
  return 0;
}

async function recv(argv) {
  const wait = Math.min(Number(flag(argv, 'wait', 0)) || 0, 60);
  const res = await request('GET', `/recv?wait=${wait}`, null, (wait + 10) * 1000);
  if (!res.messages.length) {
    console.log(wait ? `No messages after ${wait}s.` : 'No messages.');
    return 0;
  }
  for (const m of res.messages) console.log(renderMessage(m) + '\n');
  return 0;
}

const COMMANDS = { register, who, send, recv, topics: topicsCmd, topic: topicCmd };

function isBusCommand(cmd) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, cmd);
}

// Returns a promise resolving to the process exit code.
async function run(argv) {
  try {
    return await COMMANDS[argv[0]](argv);
  } catch (err) {
    console.error('termivin: ' + err.message);
    return 1;
  }
}

module.exports = { isBusCommand, run };
