// E2E test for external window attach/detach (Windows only).
// Spawns a real cmd console window (may be hosted by Windows Terminal on
// Win11), attaches it via the picker modal, verifies status, detaches, and
// confirms the window survived.

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

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

// Snapshot the picker BEFORE spawning, to identify the new window afterwards
async function listRows() {
  await page.click('#attach-window-btn');
  await page.waitForSelector('#attach-overlay:not(.hidden)');
  await page.waitForTimeout(1800); // scan
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.attach-row')].map((r) => ({
      proc: r.querySelector('.attach-proc').textContent,
      title: r.querySelector('.attach-title').textContent,
      pid: r.querySelector('.attach-pid').textContent,
    }))
  );
  return rows;
}

if (!(await page.isVisible('#attach-window-btn'))) {
  fail('attach button not visible (not Windows?)');
  process.exit(1);
}

const before = await listRows();
await page.click('#attach-cancel');

// Spawn a console window
const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'echo termivin external test'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
await new Promise((r) => setTimeout(r, 3000));

const after = await listRows();
console.log('  picker lists:', JSON.stringify(after));
const beforeKeys = new Set(before.map((r) => r.proc + '|' + r.title + '|' + r.pid));
const fresh = after.find((r) => !beforeKeys.has(r.proc + '|' + r.title + '|' + r.pid));

if (!fresh) {
  fail('newly spawned console window not found in picker');
  await page.click('#attach-cancel');
} else {
  ok(`picker lists the new window: [${fresh.proc}] ${fresh.title}`);
  const freshHandle = await page.evaluateHandle((f) => {
    return [...document.querySelectorAll('.attach-row')].find(
      (r) =>
        r.querySelector('.attach-proc').textContent === f.proc &&
        r.querySelector('.attach-title').textContent === f.title &&
        r.querySelector('.attach-pid').textContent === f.pid
    ) || null;
  }, fresh);
  await freshHandle.asElement().click();
  await page.waitForTimeout(2500);

  // --- verify attached ----------------------------------------------------
  const state = await page.evaluate(() => {
    const t = window.__termivin.S.activeWorkspace().terminals.find((x) => x.external);
    return t
      ? { hwnd: t.external.hwnd, status: window.__termivin.TM.getStatus(t.id), id: t.id }
      : null;
  });
  if (state && state.status === 'attached') ok('terminal entry status = attached');
  else fail('external terminal state: ' + JSON.stringify(state));

  // dashboard card offers Detach
  await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
  await page.waitForTimeout(800);
  const cardActions = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.card')].find((x) =>
      x.querySelector('.card-meta').textContent.includes('External'));
    return c ? c.querySelector('.card-actions').textContent : null;
  });
  if (cardActions && cardActions.includes('Detach')) ok('dashboard card offers Detach');
  else fail('external card actions: ' + cardActions);

  // --- detach -------------------------------------------------------------
  const detachBtn = await page.evaluateHandle(() => {
    const c = [...document.querySelectorAll('.card')].find((x) =>
      x.querySelector('.card-meta').textContent.includes('External'));
    return c ? [...c.querySelectorAll('button')].find((b) => b.textContent.includes('Detach')) : null;
  });
  await detachBtn.asElement().click();
  await page.waitForTimeout(2000);

  const aliveAfter = await page.evaluate((h) => window.termivin.externalAlive(h), state.hwnd);
  if (aliveAfter) ok('external window survived detach (still a valid window)');
  else fail('window no longer valid after detach');

  const statusAfter = await page.evaluate(() => {
    const t = window.__termivin.S.activeWorkspace().terminals.find((x) => x.external);
    return t ? window.__termivin.TM.getStatus(t.id) : null;
  });
  if (statusAfter === 'saved') ok('terminal entry back to saved/detached state');
  else fail('status after detach: ' + statusAfter);

  // cleanup: close the test window + remove the entry
  await page.evaluate((h) => window.termivin.externalClose(h), state.hwnd);
  const removeBtn = await page.evaluateHandle(() => {
    const c = [...document.querySelectorAll('.card')].find((x) =>
      x.querySelector('.card-meta').textContent.includes('External'));
    return c ? [...c.querySelectorAll('button')].find((b) => b.textContent.includes('Remove')) : null;
  });
  if (removeBtn.asElement()) {
    await removeBtn.asElement().click();
    await page.waitForTimeout(500);
  }
  ok('cleanup done');
}

console.log(process.exitCode ? 'EXTERNAL TEST: FAILURES' : 'EXTERNAL TEST: ALL PASSED');
await cdp.close();
