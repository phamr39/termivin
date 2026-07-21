// E2E test for workspace reordering: drag a sidebar item onto another —
// top half inserts before, bottom half after. Order persists in state.

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

const originalActive = await page.evaluate(() => window.__termivin.S.getState().activeWorkspaceId);

// need at least two workspaces — create a temp one if necessary
let createdWs = null;
if ((await page.$$('.ws-item')).length < 2) {
  await page.click('#new-workspace-btn');
  await page.waitForSelector('.ws-item .inline-rename', { timeout: 3000 });
  await page.keyboard.press('Enter'); // accept the suggested name
  await page.waitForTimeout(400);
  createdWs = await page.evaluate(() => window.__termivin.S.getState().activeWorkspaceId);
}

const order = () => page.evaluate(() => window.__termivin.S.getState().workspaces.map((w) => w.id));
const domOrder = () =>
  page.$$eval('.ws-item', (items) => items.map((i) => i.dataset.wsId));

// dispatch a synthetic HTML5 drag from one ws-item to another
const dragWs = (from, to, topHalf) =>
  page.evaluate(({ from, to, topHalf }) => {
    const src = document.querySelector(`.ws-item[data-ws-id="${from}"]`);
    const dst = document.querySelector(`.ws-item[data-ws-id="${to}"]`);
    const dt = new DataTransfer();
    const r = dst.getBoundingClientRect();
    const y = topHalf ? r.top + 2 : r.bottom - 2;
    const opts = { bubbles: true, dataTransfer: dt, clientX: r.left + 10, clientY: y };
    src.dispatchEvent(new DragEvent('dragstart', opts));
    dst.dispatchEvent(new DragEvent('dragover', opts));
    dst.dispatchEvent(new DragEvent('drop', opts));
    src.dispatchEvent(new DragEvent('dragend', opts));
  }, { from, to, topHalf });

const before = await order();
const first = before[0];
const last = before[before.length - 1];

// 1. drag the last workspace onto the first one's TOP half → becomes first
await dragWs(last, first, true);
await page.waitForTimeout(300);
let now = await order();
if (now[0] === last) ok('drop on top half inserts before → moved to first');
else fail('order after drag-to-top: ' + JSON.stringify(now));
if ((await domOrder())[0] === last) ok('sidebar DOM reflects the new order');
else fail('DOM order mismatch');

// 2. drag it onto the (new) last item's BOTTOM half → back to the end
now = await order();
await dragWs(last, now[now.length - 1], false);
await page.waitForTimeout(300);
now = await order();
if (now[now.length - 1] === last) ok('drop on bottom half inserts after → moved to end');
else fail('order after drag-to-bottom: ' + JSON.stringify(now));
if (JSON.stringify(now) === JSON.stringify(before)) ok('original order restored');
else fail('order differs from original: ' + JSON.stringify(now));

// 3. order persists (saved state)
await page.evaluate(() => window.__termivin.S.saveNowSync());
const persisted = await page.evaluate(async () => {
  const loaded = await window.termivin.loadState();
  return loaded.workspaces.map((w) => w.id);
});
if (JSON.stringify(persisted) === JSON.stringify(now)) ok('order persisted to disk');
else fail('persisted order mismatch');

// cleanup
if (createdWs) {
  await page.evaluate((id) => window.__termivin.S.removeWorkspace(id), createdWs);
}
await page.evaluate((id) => {
  window.__termivin.S.setActiveWorkspace(id);
  window.__termivin.S.saveNowSync();
}, originalActive);
await page.reload();

console.log(process.exitCode ? 'WS-REORDER TEST: FAILURES' : 'WS-REORDER TEST: ALL PASSED');
await cdp.close();
