// E2E test for all rename flows: workspace (pencil + dblclick), tab, pane bar.
// Needs at least one terminal — creates one if absent.

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

// ensure a terminal exists
if (!(await page.$('.tab'))) {
  await page.click('#new-terminal-btn');
  await page.waitForSelector('#modal-overlay:not(.hidden)');
  await page.selectOption('#nt-type', 'shell');
  await page.click('#nt-create');
  await page.waitForSelector('.tab', { timeout: 5000 });
  await page.waitForTimeout(2000);
}

// 1. workspace rename via pencil button
await page.hover('.ws-item');
await page.click('.ws-item .ws-ren');
await page.waitForSelector('.ws-item .inline-rename');
await page.fill('.ws-item .inline-rename', 'My Renamed WS');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
let name = (await page.textContent('.ws-item .ws-name')).trim();
if (name === 'My Renamed WS') ok('workspace renamed via pencil');
else fail('ws name after pencil rename: ' + name);

// 2. workspace rename via double-click
await page.dblclick('.ws-item .ws-name');
await page.waitForSelector('.ws-item .inline-rename');
await page.fill('.ws-item .inline-rename', 'WS Two');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
name = (await page.textContent('.ws-item .ws-name')).trim();
if (name === 'WS Two') ok('workspace renamed via dblclick');
else fail('ws name after dblclick rename: ' + name);

// 3. tab rename via double-click
await page.click('.tab');
await page.waitForTimeout(300);
await page.dblclick('.tab .tab-name');
await page.waitForSelector('.tab .inline-rename');
await page.fill('.tab .inline-rename', 'Renamed Tab');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
name = (await page.textContent('.tab .tab-name')).trim();
if (name === 'Renamed Tab') ok('terminal renamed via tab dblclick');
else fail('tab name after rename: ' + name);

// 4. pane title-bar rename via double-click on the name
await page.dblclick('.pane:not(.hidden) .pane-name');
await page.waitForSelector('.pane .inline-rename');
await page.fill('.pane .inline-rename', 'Pane Renamed');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
name = (await page.textContent('.pane:not(.hidden) .pane-name')).trim();
if (name === 'Pane Renamed') ok('terminal renamed via pane title bar');
else fail('pane name after rename: ' + name);

// tab reflects the pane rename
const tabName = (await page.textContent('.tab .tab-name')).trim();
if (tabName === 'Pane Renamed') ok('tab name stays in sync');
else fail('tab shows: ' + tabName);

console.log(process.exitCode ? 'RENAME TEST: FAILURES' : 'RENAME TEST: ALL PASSED');
await cdp.close();
