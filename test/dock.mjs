// E2E test for the minimize-to-dock feature: the − pane button collapses a
// terminal into a chip on the right edge; the chip restores it. The terminal
// keeps running while docked.

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

// create a throwaway shell terminal to dock
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'DockMe');
await page.click('#nt-create');
await page.waitForSelector('.pane:not(.hidden)', { timeout: 5000 });
await page.waitForTimeout(1500);

const termId = await page.evaluate(() => {
  const t = window.__termivin.S.activeWorkspace().terminals.find((x) => x.name === 'DockMe');
  return t && t.id;
});
if (termId) ok('test terminal created');
else { fail('test terminal missing'); process.exit(1); }

// 1. minimize via the − pane button
await page.click(`.pane[data-term-id="${termId}"] .pane-min`);
await page.waitForTimeout(400);

const docked = await page.evaluate((id) => {
  const { S, TM } = window.__termivin;
  const t = S.findTerminal(id).meta;
  const pane = document.querySelector(`.pane[data-term-id="${id}"]`);
  const chip = document.querySelector(`#dock .dock-chip[data-term-id="${id}"]`);
  return {
    minimized: t.minimized,
    paneHidden: pane.classList.contains('hidden'),
    chipText: chip ? chip.textContent : null,
    previewText: chip?.querySelector('.dock-preview')?.textContent ?? null,
    dockVisible: !document.getElementById('dock').classList.contains('hidden'),
    running: TM.isRunning(id),
    tabDimmed: document.querySelector(`.tab[data-term-id="${id}"]`)?.classList.contains('minimized'),
  };
}, termId);
if (docked.minimized) ok('state flag set');
else fail('minimized flag not set');
if (docked.paneHidden) ok('pane hidden from canvas');
else fail('pane still visible');
if (docked.dockVisible && docked.chipText && docked.chipText.includes('DockMe')) ok('dock chip shows the terminal');
else fail('dock chip missing: ' + JSON.stringify(docked.chipText));
if (docked.previewText && docked.previewText.length > 0 && docked.previewText !== '(no output yet)')
  ok('chip has a live output preview');
else fail('chip preview: ' + JSON.stringify(docked.previewText));
if (docked.running) ok('terminal keeps running while docked');
else fail('terminal stopped when docked');
if (docked.tabDimmed) ok('tab dimmed while docked');
else fail('tab not marked minimized');

// 2. restore via the chip
await page.click(`#dock .dock-chip[data-term-id="${termId}"]`);
await page.waitForTimeout(400);

const restored = await page.evaluate((id) => {
  const { S } = window.__termivin;
  const t = S.findTerminal(id).meta;
  const pane = document.querySelector(`.pane[data-term-id="${id}"]`);
  return {
    minimized: t.minimized,
    paneVisible: !pane.classList.contains('hidden'),
    active: S.activeWorkspace().activeTerminalId === id,
    dockHidden: document.getElementById('dock').classList.contains('hidden'),
  };
}, termId);
if (!restored.minimized && restored.paneVisible) ok('chip click restores the pane');
else fail('restore failed: ' + JSON.stringify(restored));
if (restored.active) ok('restored terminal becomes active');
else fail('restored terminal not active');
if (restored.dockHidden) ok('empty dock hides itself');
else fail('dock still visible with no chips');

// 3. minimize again, then restore via tab click
await page.click(`.pane[data-term-id="${termId}"] .pane-min`);
await page.waitForTimeout(300);
await page.click(`.tab[data-term-id="${termId}"]`);
await page.waitForTimeout(400);
const viaTab = await page.evaluate((id) => !window.__termivin.S.findTerminal(id).meta.minimized, termId);
if (viaTab) ok('tab click restores a docked terminal');
else fail('tab click did not restore');

// cleanup (direct state calls, no confirm dialog)
await page.evaluate((id) => {
  window.__termivin.TM.disposeTerminal(id);
  window.__termivin.S.removeTerminal(id);
}, termId);
await page.evaluate(() => window.__termivin.S.saveNowSync());

console.log(process.exitCode ? 'DOCK TEST: FAILURES' : 'DOCK TEST: ALL PASSED');
await cdp.close();
