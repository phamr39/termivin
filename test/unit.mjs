// Unit tests for the pure renderer modules (state.js, presets.js) — run in
// plain Node with a stubbed `window.termivin`, so they work in CI on every OS.
//   node test/unit.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let known = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    failures++;
  }
};
// Documented defects that a later change will fix: reported, not failed.
const knownIssue = (name, cond) => {
  if (cond) console.log('PASS  ' + name + ' (known issue fixed — turn this into a check)');
  else {
    console.log('KNOWN ' + name);
    known++;
  }
};

const saved = [];
globalThis.window = {
  termivin: {
    platform: process.platform,
    homedir: os.homedir(),
    loadState: async () => null,
    saveState: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    saveStateSync: () => true,
  },
};

// The renderer modules are ES modules with a .js extension (the browser loads
// them as modules); copy them to .mjs so every Node version treats them so.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termivin-unit-'));
fs.mkdirSync(path.join(tmp, 'renderer'));
for (const f of ['state.js', 'presets.js']) {
  const src = fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8')
    .replace("'../shared/approval.js'", JSON.stringify(pathToFileURL(path.join(root, 'src/shared/approval.js')).href));
  fs.writeFileSync(path.join(tmp, 'renderer', f.replace('.js', '.mjs')), src);
}
const S = await import(pathToFileURL(path.join(tmp, 'renderer', 'state.mjs')).href);
const P = await import(pathToFileURL(path.join(tmp, 'renderer', 'presets.mjs')).href);

// --- state.js ---------------------------------------------------------------

await S.loadState();
const ws1 = S.activeWorkspace();
check('first run creates one workspace', S.getState().workspaces.length === 1 && ws1.name === 'Workspace 1');

const ws2 = S.addWorkspace('Riverside');
const ws3 = S.addWorkspace('Ocean Park');
check('addWorkspace activates the new one', S.getState().activeWorkspaceId === ws3.id);

S.moveWorkspace(ws3.id, ws1.id);
check('moveWorkspace inserts before the target',
  S.getState().workspaces.map((w) => w.name).join() === 'Ocean Park,Workspace 1,Riverside');
S.moveWorkspace(ws3.id, null);
check('moveWorkspace to the end',
  S.getState().workspaces.map((w) => w.name).join() === 'Workspace 1,Riverside,Ocean Park');

const a = S.addTerminal(ws2.id, { name: 'TermiFast', type: 'claude' });
const b = S.addTerminal(ws2.id, { name: 'TermiEco', type: 'codex' });
const c = S.addTerminal(ws2.id, { name: 'TermiUni', type: 'shell' });
check('addTerminal fills defaults', a.cwd === os.homedir() && a.autoRestore === true && a.layout && a.savedTail.length === 0);
check('terminal ids are unique', new Set([a.id, b.id, c.id]).size === 3);

S.moveTerminal(c.id, ws2.id, a.id);
check('moveTerminal reorders within a workspace', ws2.terminals.map((t) => t.name).join() === 'TermiUni,TermiFast,TermiEco');
S.moveTerminal(b.id, ws3.id);
check('moveTerminal across workspaces', ws3.terminals[0] === b && !ws2.terminals.includes(b) && ws3.activeTerminalId === b.id);

S.renameTerminal(a.id, '  TermiPearl  ');
check('renameTerminal trims', S.findTerminal(a.id).meta.name === 'TermiPearl');
S.renameTerminal(a.id, '   ');
check('renameTerminal ignores blank names', S.findTerminal(a.id).meta.name === 'TermiPearl');

ws2.activeTerminalId = a.id;
S.removeTerminal(a.id);
check('removeTerminal picks a new active terminal', ws2.activeTerminalId === c.id && !S.findTerminal(a.id));

S.setActiveWorkspace(ws3.id);
const orphans = S.removeWorkspace(ws3.id);
check('removeWorkspace returns its terminals', orphans.length === 1 && orphans[0] === b);
check('removeWorkspace moves the active workspace', S.getState().activeWorkspaceId === ws2.id);
S.removeWorkspace(ws1.id);
S.removeWorkspace(ws2.id);
check('removing the last workspace leaves a fresh one', S.getState().workspaces.length === 1);

await new Promise((r) => setTimeout(r, 500));
check('mutations are persisted (debounced)', saved.length >= 1);

// --- presets.js: permission modes --------------------------------------------

check('readPermissionMode reads the flag', P.readPermissionMode('claude --continue --permission-mode plan') === 'plan');
check('readPermissionMode ignores unknown modes', P.readPermissionMode('claude --permission-mode bogus') === '');

// --- presets.js: approval detection ------------------------------------------

const claudeMenu = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│   npm test                               │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  "│   2. Yes, and don't ask again this session │",
  '│   3. No, and tell Claude what to do      │',
  '╰──────────────────────────────────────────╯',
].map((l) => l.trimEnd());
check('Claude permission menu → menu', P.detectApproval(claudeMenu)?.kind === 'menu');
check('y/n prompt → yn', P.detectApproval(['Overwrite file? [y/N]'])?.kind === 'yn');
check('generic confirm → enter', P.detectApproval(['Do you want to continue?'])?.kind === 'enter');
check('shell prompt after an answered menu → none',
  P.detectApproval([...claudeMenu, '', 'Ran npm test', 'PS C:\\work>']) === null);
check('plain output → none', P.detectApproval(['compiling...', 'done in 2.1s']) === null);
check('empty → none', P.detectApproval(['', '']) === null);

// Claude's own numbered answer, sitting above its idle input box, is not a
// permission prompt — approving it would press Enter into the input box.
check('numbered plan in an answer is not an approval', P.detectApproval([
  'Plan:',
  '1. Run the migration',
  '2. Update the tests',
  '',
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
]) === null);

const menu = P.detectApproval(claudeMenu);
check('menu exposes its options', menu.options.map((o) => o.key).join() === '1,2,3' && menu.options[0].label === 'Yes', menu.options);
check('menu carries the question and what it is about', menu.question === 'Do you want to proceed?' && menu.excerpt.includes('npm test'), menu);
const again = P.detectApproval([...claudeMenu]);
check('same prompt → same hash', again.hash === menu.hash);
const other = P.detectApproval(claudeMenu.map((l) => l.replace('npm test', 'rm -rf dist')));
check('different command → different hash', other.hash !== menu.hash);
check('optionKeys picks a menu option by number', P.optionKeys(menu, '2') === '2' && P.optionKeys(menu, '9') === null);
check('optionKeys for y/n', P.optionKeys(P.detectApproval(['Continue? [y/N]']), 'n') === 'n\r');
check('menu with a hint row below it',
  P.detectApproval(['Do you want to make this edit to a.ts?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel · Tab to amend'])?.kind === 'menu');
check('menu whose first option is not a yes → none',
  P.detectApproval(['Select a model:', '❯ 1. Opus', '  2. Sonnet']) === null);
// Claude Code's folder-trust dialog: an arrow-key list without numbers,
// with "No" preselected.
const trust = [
  '──────────────────────────────────────────────────────────────────────────────',
  ' Accessing workspace:',
  '',
  ' C:\\work\\demo',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like',
  ' your own code, a well-known open source project, or work from your team). If',
  " not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
];
const sel = P.detectApproval(trust);
check('unnumbered select list (trust dialog) → select', sel?.kind === 'select' && sel.options.length === 2 && sel.selected === 0, sel);
check('select option 2 = one ↓ then Enter', P.optionKeys(sel, '2') === '\x1b[B\r');
check('select option 1 = Enter', P.optionKeys(sel, '1') === '\r');
check('desktop Approve on a select picks the yes option, not the preselected No', P.approvalKeys('select', true, sel) === '\x1b[B\r');
check('select without its Enter hint → none', P.detectApproval(trust.slice(0, -2)) === null);
check('summarize skips option rows and the PowerShell banner',
  P.summarize(['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', 'Bash command', '> 1. Yes', '  2. No']) === 'Bash command');
check('summarize skips prompts and chrome',
  P.summarize(['Editing src/api/users.ts', '╭────╮', '│ >  │', '╰────╯', '? for shortcuts']) === 'Editing src/api/users.ts');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nUNIT: ${failures} FAILURE(S)` : `\nUNIT: ALL PASSED${known ? ` (${known} known issue)` : ''}`);
process.exit(failures ? 1 : 0);
