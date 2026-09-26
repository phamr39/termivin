// E2E test for ⋯ → "Restart (keep session)": the process is stopped and
// started again with the restore command, the old output stays on screen,
// and the new process is fully live (input works, it is not marked exited by
// the old process's late exit event). Uses a plain shell whose restore command
// is an `echo`, so it runs anywhere without Claude Code installed.
//
//   npm run start:dev
//   node test/restart.mjs 9223

import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '9223';
let fails = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    fails++;
  }
};

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = cdp.contexts()[0].pages().find((p) => p.url().includes('index.html')) || cdp.contexts()[0].pages()[0];
await page.waitForSelector('.ws-item', { timeout: 10000 });

await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'RestartSrc');
await page.fill('#nt-restore', 'echo RESUMED_OK');
await page.click('#nt-create');
await page.waitForSelector('.pane:not(.hidden)', { timeout: 5000 });
await page.waitForTimeout(2500);

const termId = await page.evaluate(() =>
  window.__termivin.S.activeWorkspace().terminals.find((t) => t.name === 'RestartSrc').id);

const bufferText = () => page.evaluate((id) => {
  const buf = window.__termivin.TM.getRuntime(id).xterm.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) || '');
  return out.join('\n');
}, termId);

const typeLine = async (text) => {
  await page.evaluate((id) => window.__termivin.TM.focusTerminal(id), termId);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

await typeLine('echo BEFORE_MARK');
await page.waitForTimeout(1500);

const clickMenu = async (label) => {
  await page.click(`.pane[data-term-id="${termId}"] .pane-more`);
  await page.waitForSelector('.pane-menu');
  const clicked = await page.evaluate((label) => {
    const item = [...document.querySelectorAll('.pane-menu-item')].find((b) => b.textContent.includes(label));
    if (item) item.click();
    return !!item;
  }, label);
  return clicked;
};

check('menu offers Restart for a running terminal', await clickMenu('Restart (keep session)'));
// An idle plain shell has nothing to lose — no confirm expected; accept one if shown.
await page.waitForTimeout(300);
if (await page.$('.dialog-overlay:not(.hidden)')) await page.click('.dialog-ok');
await page.waitForTimeout(3000);

let text = await bufferText();
const restartAt = text.indexOf('restarting: echo RESUMED_OK');
check('old output is still on screen', text.indexOf('BEFORE_MARK') !== -1 && text.indexOf('BEFORE_MARK') < restartAt, restartAt);
check('restart banner shows the resume command', restartAt !== -1);
check('restore command ran after the restart', text.indexOf('RESUMED_OK', restartAt + 30) !== -1, text.slice(-400));
check('terminal is running after restart', await page.evaluate((id) => window.__termivin.TM.isRunning(id), termId));

// Two restarts back to back: the first process's late exit must not mark the
// newest one exited or unhook its input.
await clickMenu('Restart (keep session)');
await page.waitForTimeout(150);
if (await page.$('.dialog-overlay:not(.hidden)')) await page.click('.dialog-ok');
await page.waitForTimeout(200);
await clickMenu('Restart (keep session)');
await page.waitForTimeout(150);
if (await page.$('.dialog-overlay:not(.hidden)')) await page.click('.dialog-ok');
await page.waitForTimeout(3500);
check('still running after rapid restarts', await page.evaluate((id) => window.__termivin.TM.isRunning(id), termId));
await typeLine('echo AFTER_MARK');
await page.waitForTimeout(1500);
text = await bufferText();
check('input reaches the restarted process', /AFTER_MARK[\s\S]*AFTER_MARK/.test(text) || text.split('AFTER_MARK').length >= 3, text.slice(-300));
check('not marked exited', !text.slice(text.lastIndexOf('restarting:')).includes('[process exited'), text.slice(-300));

// cleanup
await page.evaluate((id) => {
  const { S, TM } = window.__termivin;
  TM.disposeTerminal(id);
  S.removeTerminal(id);
  S.saveNowSync();
}, termId);
await cdp.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
