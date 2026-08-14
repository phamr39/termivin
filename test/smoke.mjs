// E2E smoke test: drives the running Termivin window over CDP.
// Usage: `npm run start:debug`, then `node test/smoke.mjs`.

import { chromium } from 'playwright-core';
import { readFile } from 'fs/promises';

const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  process.exitCode = 1;
};

const PORT = process.argv[2] || '9222';
const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];
page.on('dialog', (d) => d.accept());

// confirms now use the app's themed dialog instead of native confirm()
const acceptDialog = async () => {
  await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
  await page.click('.dialog-ok');
};

await page.waitForSelector('.ws-item', { timeout: 10000 });

// Start from a clean slate so pane counts below are deterministic: drop every
// terminal, keep one workspace on canvas, leave Home.
await page.evaluate(() => {
  const { S, TM } = window.__termivin;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) {
      TM.disposeTerminal(t.id);
      S.removeTerminal(t.id);
    }
  }
  const state = S.getState();
  state.appView = 'ws';
  state.workspaces[0].view = 'canvas';
});
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 10000 });
ok('workspace sidebar renders: ' + (await page.textContent('#workspace-list .ws-item .ws-name')).trim());

// --- create a plain shell terminal ---------------------------------------
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
ok('new-terminal modal opens');

const namePh = await page.getAttribute('#nt-name', 'placeholder');
if (/^Termi(Mec|School|Uni|Space|Fast|Wonder|Safari|Homes|Pearl|Film|City|Eco|Com)/.test(namePh)) {
  ok('terminal name placeholder is Termi-style: ' + namePh);
} else {
  fail('unexpected terminal placeholder: ' + namePh);
}

await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'smoke shell');
await page.click('#nt-create');
await page.waitForSelector('.tab', { timeout: 5000 });
ok('terminal tab created');

await page.waitForTimeout(4000); // let the shell boot

// --- canvas: floating pane visible ---------------------------------------
const visPanes = await page.evaluate(
  () => document.querySelectorAll('#panes .pane:not(.hidden)').length
);
if (visPanes === 1) ok('canvas shows 1 floating pane');
else fail('visible panes: ' + visPanes);

// --- echo roundtrip -------------------------------------------------------
await page.click('.pane:not(.hidden) .pane-body');
await page.keyboard.type('echo hello-termivin', { delay: 20 });
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);
const termText = await page.evaluate(
  () => document.querySelector('.pane:not(.hidden) .xterm-rows')?.innerText || ''
);
if (termText.includes('hello-termivin')) ok('PTY echo roundtrip works');
else fail('terminal did not echo. got: ' + JSON.stringify(termText.slice(0, 300)));

// --- second terminal → two floating panes --------------------------------
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'second shell');
await page.click('#nt-create');
await page.waitForTimeout(2500);
const vis2 = await page.evaluate(
  () => document.querySelectorAll('#panes .pane:not(.hidden)').length
);
if (vis2 === 2) ok('canvas shows 2 floating panes simultaneously');
else fail('after second terminal, visible panes: ' + vis2);

// --- fullscreen toggle ----------------------------------------------------
await page.click('.pane[data-term-id] .pane-max'); // first pane's fullscreen button
await page.waitForTimeout(400);
const fsState = await page.evaluate(() => ({
  visible: document.querySelectorAll('#panes .pane:not(.hidden)').length,
  fs: document.querySelectorAll('#panes .pane.fullscreen:not(.hidden)').length,
}));
if (fsState.visible === 1 && fsState.fs === 1) ok('fullscreen shows exactly one maximized pane');
else fail('fullscreen state: ' + JSON.stringify(fsState));

await page.click('.pane.fullscreen .pane-max');
await page.waitForTimeout(400);
const vis3 = await page.evaluate(
  () => document.querySelectorAll('#panes .pane:not(.hidden)').length
);
if (vis3 === 2) ok('exit fullscreen returns to 2-pane canvas');
else fail('after exit fullscreen, visible panes: ' + vis3);

// remove the second terminal (pane close button + themed confirm dialog)
await page.click('.pane[data-term-id]:not(.hidden):last-child .pane-close');
await acceptDialog();
await page.waitForTimeout(600);

// --- simulate an approval prompt that actually waits for input ------------
await page.click('.pane:not(.hidden) .pane-body');
await page.keyboard.type(
  'Write-Host "Do you want to proceed?"; Write-Host "1. Yes"; Write-Host "2. No"; $null = Read-Host',
  { delay: 10 }
);
await page.keyboard.press('Enter');
await page.waitForTimeout(2500); // detection debounce is 700ms after quiet

const tabDot = await page.getAttribute('.tab .dot', 'class');
if (tabDot.includes('st-approval')) ok('approval detected on tab dot');
else fail('tab dot is: ' + tabDot);

// --- dashboard (bus map + management side panel) --------------------------
await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
await page.waitForSelector('.wsdash', { timeout: 5000 });
ok('dashboard renders map + side panel');

await page.waitForTimeout(2200);
const mapChips = await page.evaluate(() => document.querySelectorAll('#wsmap-canvas .bm-node').length);
if (mapChips === 1) ok('map shows the terminal as a chip');
else fail('map chips: ' + mapChips);

const tilesTxt = await page.evaluate(() =>
  [...document.querySelectorAll('.side-tile')].map((t) => t.textContent.trim()).join(' '));
if (/1\s*approval/.test(tilesTxt)) ok('side tiles count the approval');
else fail('side tiles: ' + tilesTxt);

if (await page.isVisible('.side-row-approval .btn-approve')) {
  await page.click('.side-row-approval .btn-approve');
  await page.waitForTimeout(1800);
  const stillApproval = await page.evaluate(() =>
    !!document.querySelector('.side-row-approval'));
  if (!stillApproval) ok('approve from the side panel clears the approval');
  else fail('approval state did not clear');
} else {
  fail('approval quick-actions not visible in side panel');
}

const badge = await page.textContent('#workspace-list .ws-item .badge-run').catch(() => null);
if (badge) ok('sidebar shows running badge: ' + badge.trim());
else fail('no running badge in sidebar');

// --- stop the process from the pane ⋯ menu --------------------------------
await page.click('#view-toggle .seg-btn[data-view="canvas"]');
await page.waitForTimeout(600);
await page.click('.pane:not(.hidden) .pane-more');
await page.waitForSelector('.pane-menu');
await page.evaluate(() => {
  const item = [...document.querySelectorAll('.pane-menu-item')]
    .find((b) => b.textContent.includes('Stop process'));
  item.click();
});
await acceptDialog();
await page.waitForTimeout(1500);
const overlayLabel = await page.textContent('.pane:not(.hidden) .pane-overlay').catch(() => '');
if (/exited|Not running/i.test(overlayLabel)) ok('stop from ⋯ menu works: ' + overlayLabel.trim().split('\n')[0]);
else fail('after stop, overlay: ' + JSON.stringify(overlayLabel.slice(0, 80)));

// --- workspace placeholder names ------------------------------------------
await page.click('#new-workspace-btn');
await page.waitForTimeout(300);
await page.keyboard.press('Enter'); // accept the suggested name
await page.waitForTimeout(300);
const wsNames = await page.evaluate(() =>
  [...document.querySelectorAll('.ws-item .ws-name')].map((e) => e.textContent.trim())
);
// Read the pool from presets.js rather than duplicating it: a hardcoded copy
// silently drifts and makes this check fail whenever a newly added name is
// the one the randomiser picks.
const presets = await readFile(new URL('../src/renderer/presets.js', import.meta.url), 'utf8');
const POOL = [...presets.match(/WORKSPACE_NAMES = \[([^\]]*)\]/s)[1].matchAll(/'([^']+)'/g)]
  .map((m) => m[1]);
const newWs = wsNames.find((n) => POOL.some((p) => n.startsWith(p)));
if (newWs) ok('new workspace got a themed name: ' + newWs);
else fail('workspace names: ' + JSON.stringify(wsNames));

// clean up the extra workspace (themed confirm dialog)
const delBtn = await page.evaluateHandle((name) => {
  const item = [...document.querySelectorAll('.ws-item')]
    .find((i) => i.querySelector('.ws-name').textContent.trim() === name);
  return item ? item.querySelector('.ws-del') : null;
}, newWs);
if (delBtn) {
  await delBtn.asElement().click();
  await acceptDialog();
  await page.waitForTimeout(400);
}

console.log(process.exitCode ? 'SMOKE TEST: FAILURES' : 'SMOKE TEST: ALL PASSED');
await cdp.close();
