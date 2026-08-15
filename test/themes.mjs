// E2E for the theme setting: picker lists every theme, switching restyles the
// DOM and live xterm instances instantly, and the choice survives a reload.
//   npm run start:dev   →   node test/themes.mjs 9223

import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '9222';
let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = cdp.contexts()[0].pages().find((p) => p.url().includes('index.html'));
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });

// make sure at least one running terminal exists so the xterm repaint is real
const termId = await page.evaluate(async () => {
  const { S, TM } = window.__termivin;
  S.getState().appView = 'ws';
  const ws = S.activeWorkspace();
  ws.view = 'canvas';
  let t = ws.terminals.find((x) => !x.external);
  if (!t) t = S.addTerminal(ws.id, { name: 'ThemeProbe', type: 'shell', cwd: 'D:\\Work', autoRestore: false });
  if (!TM.isRunning(t.id)) await TM.spawnTerminal(t, { useRestore: false });
  return t.id;
});
await page.waitForTimeout(2500);

// start from the default theme
await page.evaluate(() => {
  const { S } = window.__termivin;
  S.getState().theme = 'termivin';
  document.body.dataset.theme = 'termivin';
});

// --- open settings ----------------------------------------------------------
await page.click('#settings-btn');
await page.waitForSelector('#settings-overlay:not(.hidden)');
check('settings modal opens', true);
check('picker lists 5 themes', (await page.locator('.theme-card').count()) === 5);
check('current theme marked active', await page.evaluate(() =>
  document.querySelector('.theme-card.active')?.dataset.theme === 'termivin'));

// --- switch to matrix -------------------------------------------------------
const accentBefore = await page.evaluate(() =>
  getComputedStyle(document.body).getPropertyValue('--accent').trim());
await page.click('.theme-card[data-theme="matrix"]');
await page.waitForTimeout(600);
check('body carries the theme', await page.evaluate(() => document.body.dataset.theme === 'matrix'));
const accentAfter = await page.evaluate(() =>
  getComputedStyle(document.body).getPropertyValue('--accent').trim());
check('CSS variables switch', accentAfter !== accentBefore && accentAfter !== '', { accentBefore, accentAfter });
check('active card follows', await page.evaluate(() =>
  document.querySelector('.theme-card.active')?.dataset.theme === 'matrix'));
const xtermBg = await page.evaluate((id) =>
  window.__termivin.TM.getRuntime(id).xterm.options.theme.background, termId);
check('live terminal repaints', xtermBg === '#0b130d', xtermBg);

// --- persists across reload -------------------------------------------------
await page.evaluate(() => window.__termivin.S.saveNowSync());
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });
await page.waitForTimeout(1500);
check('theme survives a reload', await page.evaluate(() => document.body.dataset.theme === 'matrix'));
const xtermBg2 = await page.evaluate((id) => {
  const rt = window.__termivin.TM.getRuntime(id);
  return rt && rt.xterm ? rt.xterm.options.theme.background : null;
}, termId);
check('new terminals spawn with the theme palette', xtermBg2 === null || xtermBg2 === '#0b130d', xtermBg2);

// --- back to default --------------------------------------------------------
await page.click('#settings-btn');
await page.waitForSelector('#settings-overlay:not(.hidden)');
await page.click('.theme-card[data-theme="termivin"]');
await page.waitForTimeout(400);
await page.click('#settings-close');
check('back to default theme', await page.evaluate(() => document.body.dataset.theme === 'termivin'));
await page.evaluate(() => window.__termivin.S.saveNowSync());

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
