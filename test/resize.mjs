// E2E test for free pane resize: drag any edge/corner handle. Verifies the
// se corner grows the pane, the w edge grows leftwards while keeping the
// right edge put, the n edge keeps the bottom edge put, and min sizes hold.
// Needs at least one terminal — creates a shell one if absent.

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

if (!(await page.$('.pane:not(.hidden)'))) {
  await page.click('#new-terminal-btn');
  await page.waitForSelector('#modal-overlay:not(.hidden)');
  await page.selectOption('#nt-type', 'shell');
  await page.click('#nt-create');
  await page.waitForSelector('.pane:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(1500);
}

const pane = await page.$('.pane:not(.hidden)');
const termId = await pane.getAttribute('data-term-id');

const layout = () =>
  page.evaluate((id) => ({ ...window.__termivin.S.findTerminal(id).meta.layout }), termId);

async function dragHandle(dir, dx, dy) {
  const h = await page.$(`.pane[data-term-id="${termId}"] .pane-rs[data-dir="${dir}"]`);
  const box = await h.boundingBox();
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx, sy + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

// baseline: park the pane somewhere with room in every direction
await page.evaluate((id) => {
  const { S } = window.__termivin;
  const t = S.findTerminal(id).meta;
  Object.assign(t.layout, { x: 120, y: 80, w: 500, h: 320 });
  const p = document.querySelector(`.pane[data-term-id="${id}"]`);
  p.style.left = '120px'; p.style.top = '80px'; p.style.width = '500px'; p.style.height = '320px';
}, termId);
const base = await layout();

// 1. se corner: +80/+60 grows both dimensions, origin unchanged
await dragHandle('se', 80, 60);
let l = await layout();
if (Math.abs(l.w - (base.w + 80)) <= 2 && Math.abs(l.h - (base.h + 60)) <= 2) ok('se corner grows w/h');
else fail(`se resize got w=${l.w} h=${l.h}, expected ~${base.w + 80}x${base.h + 60}`);
if (l.x === base.x && l.y === base.y) ok('se resize keeps origin');
else fail(`se resize moved origin to ${l.x},${l.y}`);

// 2. w edge: drag left 50 → wider by 50, x shifts left 50, right edge fixed
const b2 = l;
await dragHandle('w', -50, 0);
l = await layout();
if (Math.abs(l.w - (b2.w + 50)) <= 2 && Math.abs(l.x - (b2.x - 50)) <= 2) ok('w edge grows leftwards');
else fail(`w resize got x=${l.x} w=${l.w}, expected x~${b2.x - 50} w~${b2.w + 50}`);
if (Math.abs(l.x + l.w - (b2.x + b2.w)) <= 2) ok('w resize keeps right edge put');
else fail('w resize moved the right edge');

// 3. n edge: drag down 40 → shorter by 40, y shifts down 40, bottom fixed
const b3 = l;
await dragHandle('n', 0, 40);
l = await layout();
if (Math.abs(l.h - (b3.h - 40)) <= 2 && Math.abs(l.y - (b3.y + 40)) <= 2) ok('n edge shrinks from top');
else fail(`n resize got y=${l.y} h=${l.h}, expected y~${b3.y + 40} h~${b3.h - 40}`);
if (Math.abs(l.y + l.h - (b3.y + b3.h)) <= 2) ok('n resize keeps bottom edge put');
else fail('n resize moved the bottom edge');

// 4. min size clamps (320x180)
await dragHandle('se', -1000, -1000);
l = await layout();
if (l.w === 320 && l.h === 180) ok('min size clamped at 320x180');
else fail(`min clamp got ${l.w}x${l.h}`);

// 5. layout persists through a re-render
await page.evaluate(() => window.__termivin.S.scheduleSave());
await page.waitForTimeout(700);
const persisted = await page.evaluate(
  (id) => ({ ...window.__termivin.S.findTerminal(id).meta.layout }), termId);
if (persisted.w === l.w && persisted.h === l.h) ok('resized layout persisted in state');
else fail('persisted layout mismatch');

// restore a sane size
await page.evaluate((id) => {
  const { S } = window.__termivin;
  const t = S.findTerminal(id).meta;
  Object.assign(t.layout, { w: 640, h: 420 });
  S.scheduleSave();
  const p = document.querySelector(`.pane[data-term-id="${id}"]`);
  p.style.width = '640px'; p.style.height = '420px';
}, termId);

console.log(process.exitCode ? 'RESIZE TEST: FAILURES' : 'RESIZE TEST: ALL PASSED');
await cdp.close();
