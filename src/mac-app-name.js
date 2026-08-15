'use strict';
// macOS takes the menu-bar title, the Dock label and the Force-Quit entry from
// the running .app bundle's Info.plist (CFBundleName) — app.setName() cannot
// override it. Unpackaged runs (`npm start`, the global `termivin` command)
// boot node_modules' generic Electron.app, so everything says "Electron".
// Rewriting the two name keys fixes all of them at once. The bundle ships
// linker-signed with no sealed resources (no Contents/_CodeSignature), so
// editing Info.plist does not invalidate its signature. npm reinstalls restore
// the stock plist, hence the check-and-patch on every launch.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const APP_NAME = 'Termivin';
const PLUTIL = '/usr/bin/plutil';

function ensureMacBundleName() {
  if (process.platform !== 'darwin') return;
  try {
    const electronRoot = path.dirname(require.resolve('electron/package.json'));
    const plist = path.join(electronRoot, 'dist', 'Electron.app', 'Contents', 'Info.plist');
    if (!fs.existsSync(plist) || !fs.existsSync(PLUTIL)) return;
    const current = execFileSync(
      PLUTIL, ['-extract', 'CFBundleName', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
    if (current === APP_NAME) return;
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync(PLUTIL, ['-replace', key, '-string', APP_NAME, plist]);
    }
  } catch {}
}

module.exports = { ensureMacBundleName };

if (require.main === module) ensureMacBundleName();
