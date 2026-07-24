// E2E: macOS "Adopt terminal" flow. Lists real terminal sessions by process,
// adopts a shell one, and verifies the managed terminal spawns at its cwd.
// Usage: `npm run start:debug`, then `node test/adopt.mjs`.

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
const acceptDialog = async () => {
  await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
  await page.click('.dialog-ok');
};

await page.waitForSelector('.ws-item', { timeout: 10000 });

// The button is labelled "Adopt terminal" on macOS and must be visible.
const btnText = (await page.textContent('#attach-window-btn')).trim();
if (/adopt/i.test(btnText)) ok('adopt button shows: ' + btnText);
else fail('unexpected adopt button label: ' + btnText);

await page.click('#attach-window-btn');
await page.waitForSelector('#attach-overlay:not(.hidden)', { timeout: 3000 });
ok('adopt modal opens');

const title = (await page.textContent('#attach-overlay .modal-title')).trim();
if (/adopt terminal session/i.test(title)) ok('modal title adapted for mac: ' + title);
else fail('modal title: ' + title);

await page.waitForSelector('.attach-row', { timeout: 8000 });
const rows = await page.$$eval('.attach-row', (els) =>
  els.map((e) => ({
    proc: e.querySelector('.attach-proc')?.textContent || '',
    title: e.querySelector('.attach-title')?.textContent || '',
  }))
);
ok('adopt list populated: ' + rows.length + ' session(s)');

// Every row should carry an absolute cwd as its title.
const withCwd = rows.filter((r) => r.title.startsWith('/'));
if (withCwd.length) ok('rows expose absolute cwd, e.g. ' + withCwd[0].title);
else fail('no row exposed an absolute cwd: ' + JSON.stringify(rows.slice(0, 3)));

// Prefer adopting a plain shell (cheap) over launching an agent.
const shellIdx = rows.findIndex((r) => /^(zsh|bash|fish|sh|ksh|tcsh)$/i.test(r.proc.trim()));
if (shellIdx === -1) { fail('no shell session found to adopt'); await cdp.close(); process.exit(); }
const target = rows[shellIdx];
ok('adopting shell at ' + target.title);

const tabsBefore = await page.$$eval('.tab', (t) => t.length);
await page.$$eval('.attach-row', (els, i) => els[i].click(), shellIdx);

await page.waitForFunction((n) => document.querySelectorAll('.tab').length > n, tabsBefore, { timeout: 5000 });
ok('adopt created a new managed terminal tab');

await page.waitForTimeout(3500); // let the shell boot at its cwd

// Prove it really spawned in the adopted folder. Scope to the newest pane and
// force the click past xterm's pointer-intercepting screen overlay.
const pane = page.locator('.pane:not(.hidden)').last();
await pane.locator('.pane-body').click({ force: true });
await page.keyboard.type('pwd', { delay: 20 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const termText = await pane.locator('.xterm-rows').innerText();
if (termText.includes(target.title)) ok('managed terminal is running in adopted cwd: ' + target.title);
else fail('pwd did not show adopted cwd. got: ' + JSON.stringify(termText.slice(-200)));

// cleanup: close the adopted pane
await page.click('.pane:not(.hidden):last-child .pane-close');
await acceptDialog().catch(() => {});
await page.waitForTimeout(400);

console.log(process.exitCode ? 'ADOPT TEST: FAILURES' : 'ADOPT TEST: ALL PASSED');
await cdp.close();
