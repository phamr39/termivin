// E2E restore test: run AFTER smoke.mjs left a terminal in the saved state
// and the app has been restarted. Verifies the restore banner and restore-all.

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

await page.waitForSelector('.ws-item', { timeout: 10000 });

if (await page.isVisible('#restore-banner')) ok('restore banner shown after relaunch');
else fail('restore banner not visible');

const bannerText = await page.textContent('#restore-banner .restore-text');
ok('banner says: ' + bannerText.trim());

await page.click('#restore-all-btn');
await page.waitForTimeout(4000);

// last session may have ended in dashboard view — switch back to canvas
await page.click('#view-toggle .seg-btn[data-view="canvas"]');
await page.waitForTimeout(500);

const dot = await page.getAttribute('.tab .dot', 'class');
if (dot.includes('st-working') || dot.includes('st-idle')) ok('restored terminal is running (' + dot + ')');
else fail('restored terminal dot: ' + dot);

// the replay marker is in scrollback (xterm renders only the viewport) —
// scroll to the top of the buffer before reading
await page.hover('.pane:not(.hidden)');
await page.mouse.wheel(0, -5000);
await page.waitForTimeout(400);
const termText = await page.evaluate(
  () => document.querySelector('.pane:not(.hidden) .xterm-rows')?.innerText || ''
);
if (termText.includes('previous session') || termText.includes('restored (scroll up for history)'))
  ok('previous-session tail replayed in terminal');
else fail('no session replay marker. got: ' + JSON.stringify(termText.slice(0, 200)));
await page.mouse.wheel(0, 8000); // back to the live end
await page.waitForTimeout(300);

// terminal accepts input after restore
await page.click('.pane:not(.hidden) .pane-body');
await page.keyboard.type('echo restored-ok', { delay: 20 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const after = await page.evaluate(
  () => document.querySelector('.pane:not(.hidden) .xterm-rows')?.innerText || ''
);
if (after.includes('restored-ok')) ok('restored PTY is interactive');
else fail('restored terminal not interactive');

console.log(process.exitCode ? 'RESTORE TEST: FAILURES' : 'RESTORE TEST: ALL PASSED');
await cdp.close();
