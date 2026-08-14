// E2E restore test: run AFTER the app has been restarted with at least one
// managed terminal in the saved state. The active workspace auto-restores on
// startup (no banner since the auto-restore rework) — this verifies the
// terminal comes back running, replays the previous-session tail, and is
// interactive.

import { chromium } from 'playwright-core';

const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  process.exitCode = 1;
};

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];
page.on('dialog', (d) => d.accept());

await page.waitForSelector('#workspace-list .ws-item', { timeout: 10000 });

// make sure we are looking at the workspace canvas
await page.evaluate(() => {
  const { S } = window.__termivin;
  S.getState().appView = 'ws';
  S.activeWorkspace().view = 'canvas';
});
await page.click('#workspace-list .ws-item');
await page.waitForTimeout(500);

// wait for auto-restore to spawn the saved terminals
let dot = '';
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  dot = (await page.getAttribute('.tab .dot', 'class').catch(() => '')) || '';
  if (dot.includes('st-working') || dot.includes('st-idle')) break;
}
if (dot.includes('st-working') || dot.includes('st-idle')) ok('auto-restore spawned the terminal (' + dot + ')');
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
