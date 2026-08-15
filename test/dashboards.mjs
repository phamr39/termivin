// Full functional pass: rich state, real bus traffic, topics, peek — with
// screenshots for visual review.
import { chromium } from 'playwright-core';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = process.argv[2] || '9223';
// Absolute temp path: an OS-specific one hardcoded here becomes a stray folder
// inside the checkout on every other platform.
const SHOT = path.join(os.tmpdir(), 'termivin-shots');
fs.mkdirSync(SHOT, { recursive: true });

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];
await page.waitForSelector('.ws-item', { timeout: 15000 });

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

// --- state: 2 workspaces, 4 terminals --------------------------------------
const ids = await page.evaluate(async () => {
  const S = window.__termivin.S, TM = window.__termivin.TM;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) { TM.disposeTerminal(t.id); S.removeTerminal(t.id); }
  }
  // exactly one workspace + no leftover topics from earlier runs
  while (S.getState().workspaces.length > 1) {
    S.removeWorkspace(S.getState().workspaces[1].id);
  }
  const stats = await window.termivin.busStats();
  for (const t of stats.topics) await window.termivin.busTopicDelete(t.id);
  const state = S.getState();
  const ws1 = state.workspaces[0];
  ws1.name = 'Riverside';
  ws1.view = 'canvas';
  const mk = (ws, name, type) => S.addTerminal(ws.id, { name, type, cwd: 'D:\\Work\\Termivin', autoRestore: false });
  const a = mk(ws1, 'TermiFast', 'claude');
  const b = mk(ws1, 'TermiEco', 'shell');
  const ws2 = S.addWorkspace('Ocean Park');
  const c = mk(ws2, 'TermiUni', 'claude');
  const d = mk(ws2, 'TermiPearl', 'shell');
  state.activeWorkspaceId = ws1.id;
  state.appView = 'ws';
  return { ws1: ws1.id, ws2: ws2.id, a: a.id, b: b.id, c: c.id, d: d.id };
});
await page.reload();
await page.waitForSelector('.ws-item', { timeout: 15000 });
await page.waitForTimeout(1500);

// spawn only the two plain shells (fast, no AI CLI cost)
await page.evaluate(async (ids) => {
  const S = window.__termivin.S, TM = window.__termivin.TM;
  for (const id of [ids.b, ids.d]) {
    const f = S.findTerminal(id);
    await TM.spawnTerminal(f.meta, { useRestore: false });
  }
}, ids);
await page.waitForTimeout(5000);

// --- bus: register agents + topic + traffic (HTTP, like the CLI would) -----
const bus = await page.evaluate(() => window.termivin.busInfo());
const call = (agent, method, route, body) =>
  fetch(bus.url + route, {
    method,
    headers: {
      authorization: 'Bearer ' + bus.token,
      'x-termivin-agent': agent,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

await call(ids.a, 'POST', '/register', { role: 'frontend, owns src/renderer' });
await call(ids.b, 'POST', '/register', { role: 'build & tests' });
await call(ids.c, 'POST', '/register', { role: 'API service' });
const tp = await call(ids.a, 'POST', '/topics', { name: 'deploys' });
check('topic created via HTTP', tp.ok === true, tp);
await call(ids.b, 'POST', '/publish', { to: 'TermiFast', body: 'build is green' });
await call(ids.a, 'POST', '/publish', { to: '#deploys', body: 'shipping v0.3' });
await call(ids.c, 'POST', '/publish', { to: '#deploys', body: 'Ocean Park needs the new API deployed', kind: 'ask' });
await page.waitForTimeout(800);

// --- workspace dashboard ----------------------------------------------------
await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
await page.waitForTimeout(2500);
check('wsdash renders', await page.isVisible('#wsmap-canvas'));
check('terminal chips on map', (await page.locator('#wsmap-canvas .bm-node').count()) >= 2);
check('topic bus bar on map', (await page.locator('#wsmap-canvas .bm-hub').count()) === 1);
check('traffic traces drawn', (await page.locator('#wsmap-canvas .bm-trace').count()) >= 2);
const topicsTxt = await page.textContent('#wsdash-topics');
check('topics panel lists #deploys', topicsTxt.includes('#deploys'), topicsTxt);
const feedTxt = await page.textContent('#wsdash-feed');
check('feed shows traffic', feedTxt.includes('TermiFast') || feedTxt.includes('TermiEco'), feedTxt);
const tokTxt = await page.textContent('#wsdash-tokens');
check('workspace tokens computed', /Claude/.test(tokTxt), tokTxt);
// cross-workspace chip (Ocean Park sent to rep here)
const extChip = await page.evaluate(() =>
  [...document.querySelectorAll('#wsmap-canvas .bm-node')].some((n) => n.textContent.includes('Ocean Park')));
check('cross-workspace chip appears', extChip);
await page.screenshot({ path: SHOT + '/wsdash.png' });

// --- home -------------------------------------------------------------------
await page.click('#home-item');
await page.waitForTimeout(2500);
check('home renders', await page.isVisible('#home'));
check('global map chips = workspaces', (await page.locator('#home-map-canvas .bm-node').count()) === 2);
check('global topic hub', (await page.locator('#home-map-canvas .bm-hub').count()) === 1);
check('cross-space trace on global map', (await page.locator('#home-map-canvas .bm-trace').count()) >= 1);
check('grid has 2 cards', (await page.locator('.home-card').count()) === 2);
await page.screenshot({ path: SHOT + '/home.png' });

// --- peek -------------------------------------------------------------------
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.home-term-row')];
  rows.find((r) => r.textContent.includes('TermiPearl')).click();
});
await page.waitForTimeout(1200);
check('peek opens for other-workspace terminal', await page.isVisible('#peek-overlay'));
await page.evaluate((ids) => window.__termivin.TM.sendKeys(ids.d, 'echo PEEK_OK\r'), ids);
await page.waitForTimeout(1800);
const peekTail = await page.evaluate((ids) => window.__termivin.TM.getPreview(ids.d, 8).join('\n'), ids);
check('peeked terminal interactive', peekTail.includes('PEEK_OK'), peekTail);
const activeWs = await page.evaluate(() => window.__termivin.S.getState().activeWorkspaceId);
check('active workspace untouched by peek', activeWs === ids.ws1, activeWs);
check('still on home behind peek', await page.evaluate(() => window.__termivin.S.getState().appView === 'home'));
await page.screenshot({ path: SHOT + '/peek.png' });
await page.click('#peek-close');
await page.waitForTimeout(500);
check('peek closes cleanly', !(await page.isVisible('#peek-overlay')));
check('pane returned to #panes', await page.evaluate((ids) => {
  const rt = window.__termivin.TM.getRuntime(ids.d);
  return rt.pane.parentElement.id === 'panes' && !rt.pane.classList.contains('peeked');
}, ids));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
