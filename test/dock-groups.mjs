// E2E for dock groups: minimized terminals fold into named, collapsible
// groups via the chip's right-click menu.
//   npm run start:dev   →   node test/dock-groups.mjs 9223

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

// clean slate: one workspace, three minimized shells (metadata only — the
// dock shows saved terminals too, no need to spawn real ptys)
const ids = await page.evaluate(() => {
  const { S, TM } = window.__termivin;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) { TM.disposeTerminal(t.id); S.removeTerminal(t.id); }
  }
  const state = S.getState();
  state.appView = 'ws';
  const ws = state.workspaces[0];
  ws.view = 'canvas';
  const mk = (name) => {
    const t = S.addTerminal(ws.id, { name, type: 'shell', cwd: 'D:\\Work', autoRestore: false });
    t.minimized = true;
    return t.id;
  };
  return { ws: ws.id, a: mk('SvcAlpha'), b: mk('SvcBeta'), c: mk('Watcher') };
});
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });
await page.waitForTimeout(1000);

check('dock shows 3 loose chips', (await page.locator('#dock .dock-chip').count()) === 3);

const chip = (id) => `#dock .dock-chip[data-term-id="${id}"]`;
const menuItem = (label) =>
  page.evaluate((label) => {
    const item = [...document.querySelectorAll('.pane-menu-item')]
      .find((b) => b.textContent.includes(label));
    if (item) item.click();
    return !!item;
  }, label);

// --- create a group from a chip's context menu ------------------------------
await page.click(chip(ids.a), { button: 'right' });
await page.waitForSelector('.pane-menu');
check('chip menu opens', true);
await menuItem('New group');
await page.waitForSelector('.dialog-overlay:not(.hidden)');
await page.fill('.dialog-input', 'services');
await page.click('.dialog-ok');
await page.waitForTimeout(500);
check('group header appears', (await page.textContent('#dock .dock-group-name').catch(() => '')) === 'services');
check('group count is 1', (await page.textContent('#dock .dock-group-count')) === '1');

// --- move a second chip into the existing group -----------------------------
await page.click(chip(ids.b), { button: 'right' });
await page.waitForSelector('.pane-menu');
const moved = await menuItem('Move to "services"');
check('menu offers the existing group', moved);
await page.waitForTimeout(500);
check('group count is 2', (await page.textContent('#dock .dock-group-count')) === '2');
check('one loose chip remains', (await page.locator('#dock > .dock-chip').count()) === 1);

// --- collapse / expand ------------------------------------------------------
await page.click('#dock .dock-group-head');
await page.waitForTimeout(400);
check('collapse hides member chips', (await page.locator('#dock .dock-group .dock-chip').count()) === 0);
const collapsedPersisted = await page.evaluate((ws) =>
  window.__termivin.S.getWorkspace(ws).dockCollapsed.services === true, ids.ws);
check('collapsed state persisted on the workspace', collapsedPersisted);
await page.click('#dock .dock-group-head');
await page.waitForTimeout(400);
check('expand shows member chips again', (await page.locator('#dock .dock-group .dock-chip').count()) === 2);

// --- rename the group via its header menu -----------------------------------
await page.click('#dock .dock-group-head', { button: 'right' });
await page.waitForSelector('.pane-menu');
await menuItem('Rename group');
await page.waitForSelector('.dialog-overlay:not(.hidden)');
await page.fill('.dialog-input', 'backend');
await page.click('.dialog-ok');
await page.waitForTimeout(500);
check('group renamed', (await page.textContent('#dock .dock-group-name')) === 'backend');

// --- dockGroup survives a reload (persistence) ------------------------------
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });
await page.waitForTimeout(1000);
check('group survives reload', (await page.textContent('#dock .dock-group-name').catch(() => '')) === 'backend');

// --- drag & drop ------------------------------------------------------------
// loose chip dropped onto the group box → joins the group
await page.dragAndDrop(chip(ids.c), '#dock .dock-group');
await page.waitForTimeout(500);
check('drag chip onto a group joins it', (await page.textContent('#dock .dock-group-count')) === '3');

// grouped chip dropped on the remove strip → leaves the group
await page.dragAndDrop(chip(ids.c), '#dock .dock-dropout');
await page.waitForTimeout(500);
check('drag to the remove strip ungroups', (await page.textContent('#dock .dock-group-count')) === '2');
check('chip is loose again', (await page.locator('#dock > .dock-chip').count()) === 1);

// --- ungroup ----------------------------------------------------------------
await page.click('#dock .dock-group-head', { button: 'right' });
await page.waitForSelector('.pane-menu');
await menuItem('Ungroup');
await page.waitForTimeout(500);
check('ungroup flattens the dock', (await page.locator('#dock .dock-group').count()) === 0);
check('all 3 chips loose again', (await page.locator('#dock .dock-chip').count()) === 3);

// dropping one loose chip onto another creates an instant auto-named group
await page.dragAndDrop(chip(ids.a), chip(ids.b));
await page.waitForTimeout(500);
check('chip-on-chip drop creates an auto-named group',
  (await page.locator('#dock .dock-group').count()) === 1 &&
  (await page.textContent('#dock .dock-group-name')) === 'Group', {
    groups: await page.locator('#dock .dock-group').count(),
    name: await page.textContent('#dock .dock-group-name').catch(() => null),
  });
check('auto group holds both chips', (await page.textContent('#dock .dock-group-count')) === '2');

// cleanup
await page.evaluate(() => {
  const { S, TM } = window.__termivin;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) { TM.disposeTerminal(t.id); S.removeTerminal(t.id); }
  }
});

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
