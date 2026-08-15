// Regression test for the Windows right-click paste duplication: Claude Code
// enables mouse tracking and pastes the clipboard itself when it sees the
// right-click report, so Termivin's contextmenu handler must NOT paste on top
// of it (term-manager.js defers to the app when mouseTrackingMode != none).
// Needs the `claude` CLI on PATH; exits 2 (skip) when it can't start.
//   npm run start:dev   →   node test/paste.mjs 9223
import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '9223';
const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];
await page.waitForSelector('.ws-item', { timeout: 10000 });

// Wipe all terminals in the active workspace and land on its canvas: the
// toolbar buttons are hidden on Home and on the dashboard, where an earlier
// suite may have left the app.
await page.evaluate(() => {
  const S = window.__termivin.S, TM = window.__termivin.TM;
  const ws = S.activeWorkspace();
  for (const t of [...ws.terminals]) { TM.disposeTerminal(t.id); S.removeTerminal(t.id); }
  S.getState().appView = 'ws';
  ws.view = 'canvas';
});
await page.reload();
await page.waitForSelector('.ws-item', { timeout: 10000 });

await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'claude');
await page.fill('#nt-name', 'claude-fix-check');
// Start claude in this checkout: a folder the developer already trusts, so it
// boots to its prompt instead of the first-run trust question, which would
// leave mouse tracking off and skip the test.
await page.fill('#nt-cwd', process.cwd());
await page.click('#nt-create');
await page.waitForTimeout(1000);

const id = await page.evaluate(() => {
  const ws = window.__termivin.S.activeWorkspace();
  const t = ws.terminals[ws.terminals.length - 1];
  window.__termivin.UI_fullscreen = null;
  return t.id;
});
// fullscreen so nothing overlaps the pane
await page.evaluate((id) => {
  const ws = window.__termivin.S.activeWorkspace();
  ws.fullscreenTerminalId = id;
  ws.activeTerminalId = id;
}, id);
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
// force a re-render through the app's own path
await page.evaluate((id) => {
  const rt = window.__termivin.TM.getRuntime(id);
  rt.pane.classList.add('fullscreen');
  rt.pane.classList.remove('hidden');
  window.__termivin.TM.fitTerminal(id);
}, id);

const trackingOf = () =>
  page.evaluate((id) => window.__termivin.TM.getRuntime(id).xterm.modes.mouseTrackingMode, id);
const tailOf = (n = 40) =>
  page.evaluate(([id, n]) => window.__termivin.TM.getPreview(id, n), [id, n]);

let mode = 'none';
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(1000);
  mode = await trackingOf();
  if (mode !== 'none') break;
}
// Take the claude session down with us: left running it would be saved into the
// app state and restored on the next launch, where its full-screen UI hides the
// scrollback that test/restore.mjs looks for.
const dropTerminal = () => page.evaluate((id) => {
  window.__termivin.TM.disposeTerminal(id);
  window.__termivin.S.removeTerminal(id);
}, id);

console.log('mouseTrackingMode:', mode);
if (mode === 'none') {
  console.log('claude never enabled mouse tracking; tail:\n' + (await tailOf()).join('\n'));
  await dropTerminal();
  process.exit(2);
}
await page.waitForTimeout(2000);

const c = await page.evaluate((id) => {
  const rt = window.__termivin.TM.getRuntime(id);
  const r = rt.pane.querySelector('.pane-body').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, id);
await page.evaluate(() => window.termivin.clipboardWrite('ZQMARK9'));
await page.mouse.click(c.x, c.y, { button: 'right' });
await page.waitForTimeout(2500);

const tail = await tailOf();
const inputLines = tail.filter((l) => l.includes('❯'));
const lastInput = inputLines[inputLines.length - 1] || '';
const occ = lastInput.split('ZQMARK9').length - 1;
console.log('current input line:', JSON.stringify(lastInput));
console.log(occ === 1 ? 'PASS' : 'FAIL', 'right-click paste occurrences =', occ);

// cleanup: clear the input so nothing is submitted, then drop the session
await page.evaluate((id) => window.__termivin.TM.sendKeys(id, '\x1b'), id);
await dropTerminal();
process.exit(occ === 1 ? 0 : 1);
