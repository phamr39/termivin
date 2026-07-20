// CI-safe checks (no GUI needed): syntax-check every source file and verify
// the package ships what it needs. The real E2E suites (smoke/restore/...)
// require a display + a running app and are run locally instead.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  failures++;
};

// --- syntax checks --------------------------------------------------------

const CJS = ['src/main.js', 'src/preload.js', 'bin/termivin.js'];
const ESM = [
  'src/renderer/app.js',
  'src/renderer/ui.js',
  'src/renderer/state.js',
  'src/renderer/term-manager.js',
  'src/renderer/presets.js',
];

for (const f of CJS) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    ok('syntax ' + f);
  } catch (e) {
    fail('syntax ' + f + ': ' + e.stderr);
  }
}

// node --check parses .js as CommonJS; copy renderer ESM files to .mjs first
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termivin-ci-'));
for (const f of ESM) {
  const t = path.join(tmp, path.basename(f) + '.mjs');
  fs.copyFileSync(path.join(root, f), t);
  try {
    execFileSync(process.execPath, ['--check', t], { stdio: 'pipe' });
    ok('syntax ' + f);
  } catch (e) {
    fail('syntax ' + f + ': ' + e.stderr);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

// --- package layout -------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const f of [
  'assets/icon.ico',
  'assets/termivin-logo.png',
  'src/win-embed.ps1',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'LICENSE.md',
]) {
  if (fs.existsSync(path.join(root, f))) ok('ships ' + f);
  else fail('missing ' + f);
}

if (pkg.dependencies && pkg.dependencies.electron) {
  ok('electron is a runtime dependency (global installs work)');
} else {
  fail('electron must be in "dependencies" or `npm i -g termivin` breaks');
}

if (pkg.bin && pkg.bin.termivin === 'bin/termivin.js') ok('bin entry present');
else fail('bin entry missing/incorrect');

const filesOk = Array.isArray(pkg.files) && ['src/', 'bin/', 'assets/'].every((d) => pkg.files.includes(d));
if (filesOk) ok('"files" whitelist covers src/, bin/, assets/');
else fail('"files" whitelist incomplete');

console.log(failures ? `CI CHECK: ${failures} FAILURE(S)` : 'CI CHECK: ALL PASSED');
process.exit(failures ? 1 : 0);
