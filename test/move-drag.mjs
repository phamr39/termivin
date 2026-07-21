// E2E test for drag-pane-to-workspace: drag a terminal by its title bar onto
// a sidebar workspace item → confirm dialog → the terminal moves there.
// Cancelling leaves everything unchanged and snaps the pane back.

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

// temp target workspace (created active → click back to the original)
await page.click('#new-workspace-btn');
await page.waitForSelector('.ws-item .inline-rename', { timeout: 3000 });
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const targetWs = await page.evaluate(() => window.__termivin.S.getState().activeWorkspaceId);
await page.click(`.ws-item[data-ws-id="${originalActive}"]`);
await page.waitForTimeout(600);

// throwaway terminal to move
await page.click('#new-terminal-btn');
await page.waitForSelector('#modal-overlay:not(.hidden)');
await page.selectOption('#nt-type', 'shell');
await page.fill('#nt-name', 'MoveMe');
await page.click('#nt-create');
await page.waitForSelector('.pane:not(.hidden)', { timeout: 5000 });
await page.waitForTimeout(1500);
const termId = await page.evaluate(() =>
  window.__termivin.S.activeWorkspace().terminals.find((t) => t.name === 'MoveMe')?.id);
if (termId) ok('test terminal created');
else { fail('test terminal missing'); process.exit(1); }

const origLayout = await page.evaluate((id) =>
  ({ ...window.__termivin.S.findTerminal(id).meta.layout }), termId);

async function dragPaneToWs(wsId) {
  const bar = await page.$(`.pane[data-term-id="${termId}"] .pane-bar`);
  const b = await bar.boundingBox();
  const item = await page.$(`.ws-item[data-ws-id="${wsId}"]`);
  const w = await item.boundingBox();
  await page.mouse.move(b.x + 60, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2, { steps: 12 });
  await page.waitForTimeout(150);
  const highlighted = await page.evaluate((id) =>
    document.querySelector(`.ws-item[data-ws-id="${id}"]`).classList.contains('drop-target'), wsId);
  await page.mouse.up();
  return highlighted;
}

// 1. drop + cancel → nothing moves, pane snaps back
let highlighted = await dragPaneToWs(targetWs);
if (highlighted) ok('target workspace highlights while hovering');
else fail('no drop-target highlight during drag');
await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
ok('confirm dialog appears on drop');
await page.click('.dialog-cancel');
await page.waitForTimeout(400);
const afterCancel = await page.evaluate(({ id, wsId }) => {
  const { S } = window.__termivin;
  const f = S.findTerminal(id);
  return { inTarget: f.ws.id === wsId, layout: { ...f.meta.layout } };
}, { id: termId, wsId: targetWs });
if (!afterCancel.inTarget) ok('cancel keeps the terminal in place');
else fail('terminal moved despite cancel');
if (afterCancel.layout.x === origLayout.x && afterCancel.layout.y === origLayout.y)
  ok('pane snapped back to its original spot');
else fail('pane did not snap back: ' + JSON.stringify(afterCancel.layout));

// 2. drop + confirm → terminal moves to the target workspace
await dragPaneToWs(targetWs);
await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
await page.click('.dialog-ok');
await page.waitForTimeout(600);
const afterMove = await page.evaluate(({ id, wsId }) => {
  const { S } = window.__termivin;
  const f = S.findTerminal(id);
  return {
    inTarget: f.ws.id === wsId,
    targetActiveTerm: f.ws.activeTerminalId,
    paneHidden: document.querySelector(`.pane[data-term-id="${id}"]`).classList.contains('hidden'),
  };
}, { id: termId, wsId: targetWs });
if (afterMove.inTarget) ok('confirm moves the terminal to the target workspace');
else fail('terminal not in target workspace');
if (afterMove.paneHidden) ok('pane hidden in the source workspace view');
else fail('pane still visible in source workspace');

// cleanup: remove terminal + temp workspace, restore active
await page.evaluate(({ id, wsId, activeId }) => {
  const { S, TM } = window.__termivin;
  TM.disposeTerminal(id);
  S.removeTerminal(id);
  S.removeWorkspace(wsId);
  S.setActiveWorkspace(activeId);
  S.saveNowSync();
}, { id: termId, wsId: targetWs, activeId: originalActive });
await page.reload();

console.log(process.exitCode ? 'MOVE-DRAG TEST: FAILURES' : 'MOVE-DRAG TEST: ALL PASSED');
await cdp.close();
