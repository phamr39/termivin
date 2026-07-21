// E2E test for terminal cloning: the ❐ button opens the new-terminal dialog
// PREFILLED from the source (cwd/commands/settings + fresh pool-name
// placeholder) — the user confirms/edits before anything is created.

import { chromium } from 'playwright-core';

const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  process.exitCode = 1;
};

const cdp = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = cdp.contexts()[0].pages().find((p) => p.url().includes('index.html')) || cdp.contexts()[0].pages()[0];
page.on('dialog', (d) => d.accept());
await page.waitForSelector('.ws-item', { timeout: 10000 });

// create a throwaway shell terminal to act as the clone source
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'CloneSrc');
await page.click('#nt-create');
await page.waitForSelector('.pane:not(.hidden)', { timeout: 5000 });
await page.waitForTimeout(1500);

const before = await page.evaluate(() => {
  const { S } = window.__termivin;
  const ws = S.activeWorkspace();
  return { count: ws.terminals.length, wsId: ws.id };
});

const src = await page.evaluate(() => {
  const { S } = window.__termivin;
  const t = S.activeWorkspace().terminals.find((x) => x.name === 'CloneSrc');
  return t && { id: t.id, type: t.type, cwd: t.cwd, command: t.command, restoreCommand: t.restoreCommand };
});
if (src) ok('source terminal created');
else fail('source terminal missing');

// 1. ❐ opens the dialog prefilled — nothing is created yet
await page.click(`.pane[data-term-id="${src.id}"] .pane-clone`);
await page.waitForSelector('#modal-overlay:not(.hidden)', { timeout: 3000 });
const prefill = await page.evaluate(() => ({
  type: document.getElementById('nt-type').value,
  cwd: document.getElementById('nt-cwd').value,
  command: document.getElementById('nt-command').value,
  restore: document.getElementById('nt-restore').value,
  nameValue: document.getElementById('nt-name').value,
  namePh: document.getElementById('nt-name').placeholder,
}));
if (prefill.type === src.type) ok('type prefilled: ' + prefill.type);
else fail(`type prefill ${prefill.type} != ${src.type}`);
if (prefill.cwd === src.cwd) ok('cwd prefilled from source');
else fail(`cwd prefill ${prefill.cwd} != ${src.cwd}`);
if (prefill.command === src.command && prefill.restore === src.restoreCommand) ok('commands prefilled');
else fail('command prefill mismatch');
if (/^Termi/.test(prefill.namePh) && prefill.namePh !== 'CloneSrc' && !prefill.nameValue)
  ok('fresh pool-name suggested: ' + prefill.namePh);
else fail('name prefill unexpected: ' + JSON.stringify([prefill.nameValue, prefill.namePh]));

const midCount = await page.evaluate((wsId) =>
  window.__termivin.S.getState().workspaces.find((w) => w.id === wsId).terminals.length, before.wsId);
if (midCount === before.count) ok('nothing created while dialog is open');
else fail('terminal created prematurely');

// 2. confirm the dialog → clone is created with the prefilled values
await page.click('#nt-create');
await page.waitForTimeout(2500);
const after = await page.evaluate((wsId) => {
  const { S, TM } = window.__termivin;
  const ws = S.getState().workspaces.find((w) => w.id === wsId);
  const clone = ws.terminals[ws.terminals.length - 1];
  return {
    count: ws.terminals.length,
    clone: { id: clone.id, name: clone.name, type: clone.type, cwd: clone.cwd,
             command: clone.command, restoreCommand: clone.restoreCommand,
             running: TM.isRunning(clone.id) },
    names: ws.terminals.map((t) => t.name),
  };
}, before.wsId);
if (after.count === before.count + 1) ok('confirming created the clone');
else fail('terminal count after create: ' + after.count);
const c = after.clone;
if (c.cwd === src.cwd && c.command === src.command && c.restoreCommand === src.restoreCommand)
  ok('clone keeps cwd + commands');
else fail('clone fields differ: ' + JSON.stringify(c));
if (/^Termi/.test(c.name) && after.names.filter((n) => n === c.name).length === 1)
  ok('clone name from pool, unique: ' + c.name);
else fail('clone name unexpected: ' + c.name);
if (c.running) ok('clone spawned and running');
else fail('clone not running');

// external panes must not offer a clone button
const extHasClone = await page.evaluate(() => {
  const { S } = window.__termivin;
  const ext = S.getState().workspaces.flatMap((w) => w.terminals).find((t) => t.external);
  if (!ext) return null; // no external terminal present — skip
  const pane = document.querySelector(`.pane[data-term-id="${ext.id}"]`);
  return pane ? !!pane.querySelector('.pane-clone') : null;
});
if (extHasClone === null) ok('no external terminal to check (skipped)');
else if (extHasClone === false) ok('external pane has no clone button');
else fail('external pane shows a clone button');

// 3. dashboard Clone opens the same dialog; Esc cancels without creating
await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
await page.waitForTimeout(500);
await page.evaluate((srcId) => {
  const card = document.querySelector(`.card[data-term-id="${srcId}"]`) || document.querySelector('.card');
  [...card.querySelectorAll('.btn')].find((b) => b.textContent.includes('Clone')).click();
}, src.id);
await page.waitForSelector('#modal-overlay:not(.hidden)', { timeout: 3000 });
ok('dashboard Clone opens the dialog');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const finalCount = await page.evaluate((wsId) =>
  window.__termivin.S.getState().workspaces.find((w) => w.id === wsId).terminals.length, before.wsId);
if (finalCount === before.count + 1) ok('Esc cancels without creating');
else fail('count after cancel: ' + finalCount);

// cleanup: remove the source and the clone (direct state calls, no dialog)
await page.evaluate(({ wsId, keep }) => {
  const { S, TM } = window.__termivin;
  const ws = S.getState().workspaces.find((w) => w.id === wsId);
  for (const t of [...ws.terminals].slice(keep)) {
    TM.disposeTerminal(t.id);
    S.removeTerminal(t.id);
  }
}, { wsId: before.wsId, keep: before.count - 1 });
await page.evaluate(() => window.__termivin.S.saveNowSync());
await page.reload();

console.log(process.exitCode ? 'CLONE TEST: FAILURES' : 'CLONE TEST: ALL PASSED');
await cdp.close();
