#!/usr/bin/env node
// Global `termivin` command. With no arguments it launches the app detached
// from this terminal (the single-instance lock focuses an existing window if
// one is already open). It also exposes the usual CLI conveniences:
// --help, --version, --update, --debug.
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const bus = require('../src/bus-client');
const { ensureMacBundleName } = require('../src/mac-app-name');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
// On Windows, Node refuses to spawn a .cmd/.bat file without shell:true since
// the CVE-2024-27980 fix (Node 18.20/20.12/22+); without it the npm.cmd shim
// fails with EINVAL. shell:true is safe here because every argument we pass is
// a static, metacharacter-free literal.
const npmSpawnOpts = isWin ? { shell: true } : {};

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (...names) => argv.some((a) => names.includes(a));

function printHelp() {
  console.log(`
Termivin ${pkg.version} — ${pkg.description}

Usage:
  termivin [command] [options]

Commands:
  (none)            Launch the Termivin app
  update            Update Termivin to the latest published version

Agent bus (run these from inside a Termivin terminal):
  register          Join the workspace bus     --role "..." [--skills a,b]
  who               List the agents in this workspace
  send <to> <text>  Message an agent by name, "@all", or "#topic"  [--ask] [--subject S]
  recv              Read waiting messages      [--wait <seconds, max 60>]
  topics            List cross-workspace topics
  topic <name>      Create a topic here        [--rep <agent-name>]
                    (its representative speaks for this workspace to the outside)

Options:
  -h, --help        Show this help and exit
  -v, --version     Print the installed version and exit
  -u, --update      Same as the "update" command
      --debug       Launch with the DevTools remote debugging port (9222) open

Any unrecognized options are forwarded to Electron.

Homepage: ${pkg.homepage}
`.trim());
}

function runUpdate() {
  console.log(`Termivin ${pkg.version} - checking for a newer release...`);
  let latest = '';
  try {
    const view = spawnSync(npm, ['view', pkg.name, 'version'], { encoding: 'utf8', ...npmSpawnOpts });
    if (view.status === 0) latest = String(view.stdout || '').trim();
  } catch {}

  if (latest && latest === pkg.version) {
    console.log(`Already up to date (${pkg.version}).`);
    return 0;
  }
  if (latest) console.log(`Updating ${pkg.version} -> ${latest}...`);
  else console.log('Could not reach the npm registry; attempting update anyway...');

  const res = spawnSync(npm, ['install', '-g', `${pkg.name}@latest`], { stdio: 'inherit', ...npmSpawnOpts });
  if (res.error) {
    console.error('Update failed: ' + res.error.message);
    return 1;
  }
  if (res.status === 0) console.log('Termivin updated. Relaunch it to use the new version.');
  return res.status || 0;
}

function launch() {
  let electron;
  try {
    // When required from plain Node, the electron package exports the path to
    // the electron executable.
    electron = require('electron');
  } catch {
    console.error('Could not find Electron. Run "npm install" in ' + root);
    return 1;
  }
  // Must happen before the bundle boots — macOS reads the name once at launch.
  ensureMacBundleName();
  // Forward extra args to Electron, translating our --debug shorthand.
  const forwarded = argv.map((a) => (a === '--debug' ? '--remote-debugging-port=9222' : a));
  const child = spawn(electron, [root, ...forwarded], {
    detached: true,
    stdio: 'ignore',
    cwd: root,
  });
  child.unref();
  console.log('Termivin launched.');
  return 0;
}

function main() {
  if (cmd === 'help' || has('-h', '--help')) {
    printHelp();
    return 0;
  }
  if (cmd === 'version' || has('-v', '--version')) {
    console.log(pkg.version);
    return 0;
  }
  if (cmd === 'update' || has('-u', '--update')) {
    return runUpdate();
  }
  return launch();
}

// Agent-bus subcommands talk to the running app over HTTP, so they are async;
// everything else stays synchronous.
if (bus.isBusCommand(cmd)) {
  bus.run(argv).then((code) => process.exit(code));
} else {
  process.exit(main());
}
