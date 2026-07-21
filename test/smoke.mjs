// E2E smoke test: drives the running Termivin window over CDP.
// Usage: `npm run start:debug`, then `node test/smoke.mjs`.

import { chromium } from 'playwright-core';

const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  process.exitCode = 1;
};

const cdp = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];
page.on('dialog', (d) => d.accept());

// confirms now use the app's themed dialog instead of native confirm()
const acceptDialog = async () => {
  await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
  await page.click('.dialog-ok');
};

await page.waitForSelector('.ws-item', { timeout: 10000 });
ok('workspace sidebar renders: ' + (await page.textContent('.ws-item .ws-name')).trim());

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

// --- dashboard ------------------------------------------------------------
await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
await page.waitForSelector('.card', { timeout: 4000 });
ok('dashboard renders card');

await page.waitForTimeout(1600);
const pill = (await page.textContent('.card .status-pill')).trim();
if (pill === 'needs approval') ok('card shows "needs approval"');
else fail('card status pill: ' + pill);

const preview = await page.textContent('.card .card-preview');
if (preview.includes('Do you want to proceed?')) ok('card preview shows terminal tail');
else fail('preview: ' + JSON.stringify(preview.slice(0, 200)));

if (await page.isVisible('.card .approval-bar')) {
  await page.click('.card .btn-approve');
  await page.waitForTimeout(1800);
  const pill2 = (await page.textContent('.card .status-pill')).trim();
  if (pill2 !== 'needs approval') ok('approve clears approval state (now: ' + pill2 + ')');
  else fail('approval state did not clear');
} else {
  fail('approval bar not visible on card');
}

const badge = await page.textContent('.ws-item .badge-run').catch(() => null);
if (badge) ok('sidebar shows running badge: ' + badge.trim());
else fail('no running badge in sidebar');

// --- stop terminal from dashboard -----------------------------------------
await page.click('.card .btn-danger-text');
await page.waitForTimeout(1500);
const pill3 = (await page.textContent('.card .status-pill')).trim();
if (pill3 === 'exited' || pill3 === 'saved') ok('stop works, card status: ' + pill3);
else fail('after stop, card status: ' + pill3);

const actions = await page.textContent('.card .card-actions');
if (actions.includes('Start') || actions.includes('Resume')) ok('restart/resume actions available');
else fail('card actions: ' + actions);

// --- workspace placeholder names ------------------------------------------
await page.click('#new-workspace-btn');
await page.waitForTimeout(300);
await page.keyboard.press('Enter'); // accept the suggested name
await page.waitForTimeout(300);
const wsNames = await page.evaluate(() =>
  [...document.querySelectorAll('.ws-item .ws-name')].map((e) => e.textContent.trim())
);
const POOL = ['Riverside', 'The Harmony', 'Symphony', 'Green Villas', 'Green Bay', 'Skylake',
  'Smart City', 'West Point', 'Metropolis', 'Gardenia', 'Times City', 'Royal City', 'Ocean Park'];
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
