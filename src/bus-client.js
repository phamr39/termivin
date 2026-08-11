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
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'termivin');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'termivin');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'termivin');
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
    console.error('Usage: termivin send <agent-name|@all> "message" [--ask] [--subject S]');
    return 1;
  }
  const res = await request('POST', '/publish', {
    to,
    body: text,
    kind: argv.includes('--ask') ? 'ask' : flag(argv, 'kind', 'note'),
    subject: flag(argv, 'subject', ''),
    corr: flag(argv, 'corr', null),
  });
  console.log(`Sent to: ${res.delivered.join(', ')}`);
  if (argv.includes('--ask')) {
    console.log('This was a question. Replies arrive via `termivin recv` — keep working meanwhile.');
  }
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

const COMMANDS = { register, who, send, recv };

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
