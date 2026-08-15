// E2E test for "Convert to terminal": a detached external entry becomes a
// managed terminal at the remembered working directory. Uses a synthetic
// external entry so it runs even when no console window is available.

import { chromium } from 'playwright-core';

const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => {
  console.error('FAIL  ' + m);
  process.exitCode = 1;
};

// The remembered directory has to exist for the converted shell to start in it.
const isWin = process.platform === 'win32';
const WORK = isWin ? 'D:\\Work' : process.cwd();
const WORK_SUB = isWin ? 'D:\\Work\\Termivin' : process.cwd() + '/src';

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const page = cdp.contexts()[0].pages().find((p) => p.url().includes('index.html')) || cdp.contexts()[0].pages()[0];
page.on('dialog', (d) => d.accept());
await page.waitForSelector('.ws-item', { timeout: 10000 });

// close any modal left open by earlier interactions
await page.evaluate(() => {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.add('hidden'));
});

// synthetic detached external entry, as if attached in a past session
const termId = await page.evaluate(([work, workSub]) => {
  const S = window.__termivin.S;
  const ws = S.activeWorkspace();
  const meta = S.addTerminal(ws.id, {
    name: '✳ Fake claude session',
    type: 'external',
    cwd: work,
    external: {
      hwnd: 999999, pid: 1, title: '✳ Fake claude session', origStyle: 349110272,
      cwdCandidates: [{ name: 'node.exe', cwd: workSub }],
    },
  });
  ws.view = 'canvas';
  return meta.id;
}, [WORK, WORK_SUB]);
await page.click('#view-toggle .seg-btn[data-view="canvas"]');
await page.waitForTimeout(800);

const convBtn = await page.evaluateHandle((id) => {
  const pane = document.querySelector(`.pane[data-term-id="${id}"]`);
  return pane ? [...pane.querySelectorAll('button')].find((b) => b.textContent.includes('Convert')) : null;
}, termId);
if (!convBtn.asElement()) {
  fail('no Convert button on overlay');
  process.exit(1);
}
await convBtn.asElement().click();
await page.waitForSelector('#convert-overlay:not(.hidden)', { timeout: 5000 });
ok('convert modal opens (no click interception — z-order fix works)');

const prefill = await page.evaluate(() => ({
  type: document.getElementById('cv-type').value,
  cwd: document.getElementById('cv-cwd').value,
  opts: [...document.querySelectorAll('#cv-recent option')].map((o) => o.value),
}));
if (prefill.type === 'claude') ok('claude preselected from ✳ title heuristic');
else fail('type prefill: ' + prefill.type);
if (prefill.cwd === WORK) ok('cwd prefilled from captured value: ' + prefill.cwd);
else fail('cwd prefill: ' + prefill.cwd);
if (prefill.opts.length && prefill.opts[0] === WORK_SUB) ok('captured cwd candidate first in suggestions');
else console.log('  suggestions: ' + JSON.stringify(prefill.opts.slice(0, 3)));
if (prefill.opts.length > 1) ok('recent Claude projects appended: ' + (prefill.opts.length - 1));

// convert to a plain shell (avoid starting a real claude session in tests)
await page.selectOption('#cv-type', 'shell');
await page.fill('#cv-cwd', WORK);
await page.click('#cv-create');
await page.waitForTimeout(5000);

const after = await page.evaluate((id) => {
  const f = window.__termivin.S.findTerminal(id);
  const t = f ? f.meta : null;
  const pane = document.querySelector(`.pane[data-term-id="${id}"]`);
  return t
    ? {
        type: t.type, ext: t.external, cwd: t.cwd,
        restore: t.restoreCommand,
        status: window.__termivin.TM.getStatus(id),
        text: pane ? (pane.querySelector('.xterm-rows')?.innerText || '') : '',
      }
    : null;
}, termId);
if (after && after.type === 'shell' && !after.ext) ok('meta converted, external cleared');
else fail('meta: ' + JSON.stringify(after && { type: after.type, ext: after.ext }));
if (after && (after.status === 'working' || after.status === 'idle')) ok('converted terminal running (' + after.status + ')');
else fail('status: ' + (after && after.status));
// Ask the shell where it is rather than reading the prompt: PowerShell prints
// the full path, but zsh's default prompt abbreviates it to the folder name.
await page.click(`.pane[data-term-id="${termId}"] .pane-body`);
await page.keyboard.type('pwd', { delay: 20 });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const pwdOut = await page.evaluate((id) =>
  document.querySelector(`.pane[data-term-id="${id}"] .xterm-rows`)?.innerText || '', termId);
if (pwdOut.includes(WORK)) ok('shell opened at ' + WORK);
else fail('pwd: ' + JSON.stringify(pwdOut.slice(-250)));

// cleanup
await page.evaluate((id) => {
  window.__termivin.TM.disposeTerminal(id);
  window.__termivin.S.removeTerminal(id);
}, termId);

console.log(process.exitCode ? 'CONVERT TEST: FAILURES' : 'CONVERT TEST: ALL PASSED');
await cdp.close();
