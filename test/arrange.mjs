// E2E test for ▦ Arrange: scattered/overlapping panes get tiled into a neat
// non-overlapping grid inside the canvas. Creates two throwaway shells.

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

// two throwaway shell terminals
const made = [];
for (const nm of ['ArrangeA', 'ArrangeB']) {
  await page.click('#new-terminal-btn');
  await page.waitForSelector('#modal-overlay:not(.hidden)');
  await page.selectOption('#nt-type', 'shell');
  await page.fill('#nt-name', nm);
  await page.click('#nt-create');
  await page.waitForTimeout(1200);
  made.push(await page.evaluate((n) =>
    window.__termivin.S.activeWorkspace().terminals.find((t) => t.name === n)?.id, nm));
}
if (made.every(Boolean)) ok('two test terminals created');
else { fail('test terminals missing'); process.exit(1); }

// scatter them so they overlap
await page.evaluate(() => {
  const { S } = window.__termivin;
  for (const t of S.activeWorkspace().terminals) {
    if (!t.minimized) Object.assign(t.layout, { x: 40, y: 30, w: 500, h: 320 });
  }
});

const btnVisible = await page.evaluate(() =>
  !document.getElementById('arrange-btn').classList.contains('hidden'));
if (btnVisible) ok('Arrange button visible with >1 open terminals');
else fail('Arrange button hidden');

await page.click('#arrange-btn');
await page.waitForTimeout(500);

const check = await page.evaluate(() => {
  const { S } = window.__termivin;
  const ws = S.activeWorkspace();
  const host = document.getElementById('content').getBoundingClientRect();
  const items = ws.terminals.filter((t) => !t.minimized).map((t) => ({ ...t.layout, name: t.name }));
  const overlap = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  let anyOverlap = false;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (overlap(items[i], items[j])) anyOverlap = true;
  const inBounds = items.every((l) => l.x >= 0 && l.y >= 0 && l.y + l.h <= host.height + 2);
  const distinctPos = new Set(items.map((l) => l.x + ',' + l.y)).size === items.length;
  return { n: items.length, anyOverlap, inBounds, distinctPos, view: ws.view };
});
if (!check.anyOverlap) ok(`no overlaps among ${check.n} arranged panes`);
else fail('panes still overlap after arrange');
if (check.inBounds) ok('all panes within canvas bounds');
else fail('a pane landed outside the canvas');
if (check.distinctPos) ok('each pane got its own grid cell');
else fail('panes share a position');
if (check.view === 'canvas') ok('canvas view active');
else fail('view: ' + check.view);

// cleanup
await page.evaluate((ids) => {
  const { S, TM } = window.__termivin;
  for (const id of ids) {
    TM.disposeTerminal(id);
    S.removeTerminal(id);
  }
}, made);
await page.evaluate(() => window.__termivin.S.saveNowSync());
await page.reload();

console.log(process.exitCode ? 'ARRANGE TEST: FAILURES' : 'ARRANGE TEST: ALL PASSED');
await cdp.close();
