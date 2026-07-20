#!/usr/bin/env node
// Global `termivin` command: launches the app detached from this terminal.
// If Termivin is already running, the single-instance lock in the app simply
// focuses the existing window.

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

let electron;
try {
  // When required from plain Node, the electron package exports the path to
  // the electron executable.
  electron = require('electron');
} catch (err) {
  console.error('Could not find Electron. Run "npm install" in ' + root);
  process.exit(1);
}

const child = spawn(electron, [root, ...process.argv.slice(2)], {
  detached: true,
  stdio: 'ignore',
  cwd: root,
});
child.unref();
console.log('Termivin launched.');
