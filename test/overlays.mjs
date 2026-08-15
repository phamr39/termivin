// Verify the overlay fixes: dock hidden on Home, bus-note in the side panel
// instead of covering the map, legends as footers, brighter map borders.
import { chromium } from 'playwright-core';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SHOT = path.join(os.tmpdir(), 'termivin-shots');
fs.mkdirSync(SHOT, { recursive: true });

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] || '9222'}`);
const page = cdp.contexts()[0].pages().find((p) => p.url().includes('index.html'));
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

// state like the user's screenshot: 2 workspaces, several minimized terminals
const ids = await page.evaluate(async () => {
  const { S, TM } = window.__termivin;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) { TM.disposeTerminal(t.id); S.removeTerminal(t.id); }
  }
  while (S.getState().workspaces.length > 1) S.removeWorkspace(S.getState().workspaces[1].id);
  const stats = await window.termivin.busStats();
  for (const t of stats.topics) await window.termivin.busTopicDelete(t.id);
  const state = S.getState();
  const ws1 = state.workspaces[0];
  ws1.name = 'BeaverX';
  ws1.view = 'canvas';
  const mk = (ws, name, min) => {
    const t = S.addTerminal(ws.id, { name, type: 'claude', cwd: 'D:\\Work', autoRestore: false });
    t.minimized = !!min;
    return t.id;
  };
  mk(ws1, 'GlobalMonitor', true);
  mk(ws1, 'SocialFetcher', true);
  mk(ws1, 'Webapp', true);
  const open1 = mk(ws1, 'TermiSafari', false);
  const ws2 = S.addWorkspace('Modoc');
  mk(ws2, 'LandingPage', false);
  state.activeWorkspaceId = ws1.id;
  state.appView = 'ws';
  return { ws1: ws1.id, open1 };
});
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });
await page.waitForTimeout(1500);

// canvas: dock visible (3 minimized chips)
check('dock visible on canvas', await page.isVisible('#dock'));
check('dock has 3 chips', (await page.locator('#dock .dock-chip').count()) === 3);

// switch to Home → dock must disappear
await page.click('#home-item');
await page.waitForTimeout(2000);
check('home visible', await page.isVisible('#home'));
check('dock hidden on Home', !(await page.isVisible('#dock')));
check('home map hint is a footer (not overlay)', await page.evaluate(() => {
  const hint = document.querySelector('.home-map-hint');
  return hint && getComputedStyle(hint).position !== 'absolute';
}));
await page.screenshot({ path: SHOT + '/fix-home.png' });

// back to workspace → dock returns
await page.click('#workspace-list .ws-item');
await page.waitForTimeout(800);
check('dock returns on canvas', await page.isVisible('#dock'));

// workspace dashboard: no map-covering hint; note sits in the side panel
await page.click('#view-toggle .seg-btn[data-view="dashboard"]');
await page.waitForTimeout(2200);
check('map empty-overlay hidden when terminals exist', !(await page.isVisible('#wsmap-empty')));
check('bus note shown in side panel', await page.isVisible('#wsdash-busnote'));
check('dock hidden on dashboard view', !(await page.isVisible('#dock')));
check('legend is a footer (not overlay)', await page.evaluate(() => {
  const lg = document.querySelector('.wsdash-legend');
  return lg && getComputedStyle(lg).position !== 'absolute';
}));
await page.screenshot({ path: SHOT + '/fix-wsdash.png' });

// modal above fullscreen pane / dock (z-index ladder)
check('modal z-index above panes', await page.evaluate(() => {
  const z = parseInt(getComputedStyle(document.getElementById('modal-overlay')).zIndex, 10);
  return z > 900;
}));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
