// E2E check of the agent-bus UI wiring: the 🔗 connect button, the roster the
// renderer pushes to the bus, and the env the bus injects into a real shell.
//
// Runs against an isolated dev instance so it never touches your real app:
//   electron . --user-data-dir=<temp> --remote-debugging-port=9223
//   node test/bus-ui.mjs 9223
// (Electron's single-instance lock is scoped to --user-data-dir, so this runs
// happily alongside a Termivin you already have open.)

import { chromium } from 'playwright-core';

const PORT = process.argv[2] || '9223';
let fails = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m, detail) => {
  console.error('FAIL  ' + m + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  fails++;
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));

const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = cdp.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('index.html')) || ctx.pages()[0];

await page.waitForSelector('.ws-item', { timeout: 15000 });

// start clean: earlier suites leave terminals behind, and the counts below
// assume exactly the three terminals this test creates
await page.evaluate(() => {
  const { S, TM } = window.__termivin;
  for (const ws of [...S.getState().workspaces]) {
    for (const t of [...ws.terminals]) {
      TM.disposeTerminal(t.id);
      S.removeTerminal(t.id);
    }
  }
  S.getState().appView = 'ws';
});
await page.reload();
await page.waitForSelector('#workspace-list .ws-item', { timeout: 15000 });
const wsName = (await page.textContent('#workspace-list .ws-item .ws-name')).trim();
ok('window is up, workspace: ' + wsName);

// --- the bus started with the app ----------------------------------------
const info = await page.evaluate(() => window.termivin.busInfo());
check('bus is listening', /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url || ''), info);
check('bus issued a token', typeof info.token === 'string' && info.token.length >= 32, info.token?.length);

const busCall = (agent, route, init = {}) =>
  fetch(info.url + route, {
    ...init,
    headers: {
      authorization: 'Bearer ' + info.token,
      'x-termivin-agent': agent,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// --- create terminals -----------------------------------------------------
// "custom" with no command is just a shell, but it counts as an agent pane, so
// it gets the connect button; a plain "shell" must not.
async function newTerminal(name, type) {
  await page.click('#new-terminal-btn');
  await page.waitForSelector('#modal-overlay:not(.hidden)');
  await page.selectOption('#nt-type', type);
  await page.fill('#nt-name', name);
  await page.click('#nt-create');
  await page.waitForTimeout(1200);
}
await newTerminal('BusAlpha', 'custom');
await newTerminal('BusBeta', 'custom');
await newTerminal('BusShell', 'shell');
await page.waitForTimeout(4000); // let the shells boot

// Panes float and overlap, so raise one via its tab before clicking into it.
const focusPane = async (id) => {
  await page.click(`.tab[data-term-id="${id}"]`);
  await page.waitForTimeout(500);
};

const paneId = (name) => page.evaluate((n) =>
  [...document.querySelectorAll('#panes .pane')]
    .find((p) => p.querySelector('.pane-name')?.textContent === n)?.dataset.termId, name);

const termIds = await page.evaluate(() =>
  [...document.querySelectorAll('#panes .pane')].map((p) => p.dataset.termId)
);
check('three terminals exist', termIds.length === 3, termIds);

// --- the 🔗 button only appears on agent panes ---------------------------
const alpha = await paneId('BusAlpha');
const shellId = await paneId('BusShell');
check('connect button on agent panes', await page.locator('.pane-connect').count() === 2,
  await page.locator('.pane-connect').count());
check('no connect button on a plain shell',
  await page.locator(`.pane[data-term-id="${shellId}"] .pane-connect`).count() === 0);

// --- the renderer pushed the roster to the bus ---------------------------
const agents = await busCall(alpha, '/agents');
check('roster reached the bus', agents.status === 200, agents);
check('bus sees all three terminals', agents.json?.agents?.length === 3,
  agents.json?.agents?.map((a) => a.name));
check('bus knows the workspace name', agents.json?.me?.spaceName === wsName, agents.json?.me);
check('bus sees live status', ['idle', 'working'].includes(agents.json?.me?.status), agents.json?.me?.status);

// --- the injected env actually reaches the shell -------------------------
// Checked before the connect button runs, so the prompt text can't pollute it.
const alphaPane = `.pane[data-term-id="${alpha}"]`;
await focusPane(alpha);
await page.click(`${alphaPane} .pane-body`);
// The pane runs the platform's shell, so read the variables in its own syntax.
await page.keyboard.type(process.platform === 'win32'
  ? 'echo AGENT=$env:TERMIVIN_AGENT URL=$env:TERMIVIN_URL'
  : 'echo AGENT=$TERMIVIN_AGENT URL=$TERMIVIN_URL', { delay: 8 });
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const envOut = await page.evaluate(
  (sel) => document.querySelector(sel + ' .xterm-rows')?.innerText || '', alphaPane);
check('TERMIVIN_AGENT is in the shell env', envOut.includes('AGENT=' + alpha), envOut.slice(-200));
check('TERMIVIN_URL is in the shell env', envOut.includes('URL=' + info.url), envOut.slice(-200));

// --- the 🔗 button types the prompt --------------------------------------
await page.click(`${alphaPane} .pane-connect`);
await page.waitForSelector('.dialog-overlay:not(.hidden)', { timeout: 3000 });
const dialogText = await page.textContent('.dialog-message');
check('confirm names the target terminal', dialogText.includes('BusAlpha'), dialogText);
check('confirm names the peer count', /1 other agent/.test(dialogText), dialogText);
check('confirm says the prompt is not submitted', /press Enter yourself/.test(dialogText), dialogText);
await page.click('.dialog-ok');
await page.waitForTimeout(2500);

const screen = await page.evaluate(
  (sel) => document.querySelector(sel + ' .xterm-rows')?.innerText || '', alphaPane);
// xterm hard-wraps long lines and innerText turns each wrap into a newline —
// possibly mid-word — so compare with all whitespace removed.
const squash = (s) => s.replace(/\s+/g, '');
const flat = squash(screen);
check('prompt landed in the terminal', flat.includes(squash('termivin register')), screen.slice(-300));
check('prompt carries the workspace name', flat.includes(squash(wsName)), screen.slice(-400));
check('prompt lists the peer', flat.includes('BusBeta'), screen.slice(-400));
// The button types but never submits: the pane may be a bare shell, where a
// submitted line runs. Nothing should have executed — the give-away being the
// shell's own complaint about the prompt's first word.
check('prompt was typed, not submitted', !/command not found|not recognized/i.test(screen),
  screen.slice(-200));
// A single line, too: a newline is a submit, so a multi-line prompt would be
// chopped into fragments and drop a shell into its `>>` continuation.
check('prompt did not open a continuation prompt', !/\n>>/.test(screen), screen.slice(-200));

// --- a message sent from the bus reaches the agent -----------------------
const beta = termIds.find((id) => id !== alpha);
await busCall(beta, '/publish', {
  method: 'POST',
  body: JSON.stringify({ to: 'BusAlpha', body: 'hello from the bus test' }),
});
const pending = await page.evaluate((id) => window.termivin.busPending(id), alpha);
check('message is queued for the target', pending === 1, pending);

await cdp.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
