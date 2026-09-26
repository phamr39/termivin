// Unit tests for the main-process session hub (src/hub.js): headless screen,
// ring buffer resume, status, approval detection + verified answers.
//   node test/hub.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Hub } = require('../src/hub.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hub = new Hub();
await hub.ready;
const events = [];
hub.on('attention', () => events.push('attention'));
hub.on('approval', (id, a) => events.push('approval:' + a.hash));

hub.start('t1', { cols: 60, rows: 12, pid: 1 });
check('new session is working', hub.status('t1') === 'working');

hub.data('t1', 'hello\r\n');
hub.data('t1', 'world\r\n');
check('seq counts output', hub.get('t1').seq === 14);
check('since() returns only the missing part', hub.since('t1', 7) === 'world\r\n');
check('since(current) is empty', hub.since('t1', 14) === '');
check('since(future) is null', hub.since('t1', 99) === null);

const menu = [
  '╭──────────────────────────────╮',
  '│ Bash command                 │',
  '│   npm test                   │',
  '│ Do you want to proceed?      │',
  '│ ❯ 1. Yes                     │',
  "│   2. Yes, and don't ask again │",
  '│   3. No                      │',
  '╰──────────────────────────────╯',
].join('\r\n') + '\r\n';
hub.data('t1', menu);
await sleep(900);
const s = hub.get('t1');
check('approval detected in main', s.approval && s.approval.kind === 'menu', s.approval);
check('status becomes approval', hub.status('t1') === 'approval');
check('one approval event', events.filter((e) => e.startsWith('approval:')).length === 1, events);

// a redraw of the same prompt (status line, echo) must not re-raise it
hub.data('t1', '\x1b[s\x1b[u');
await sleep(900);
check('same prompt does not flicker or re-notify', events.filter((e) => e.startsWith('approval:')).length === 1 && s.approval);

const items = hub.attention((id) => ({ name: 'TermiFast', spaceId: 'ws1' }));
check('attention lists the approval with its options', items.length === 1 && items[0].options.length === 3 && items[0].screenHash === s.approval.hash, items);

const wrong = hub.answer('t1', { approvalId: items[0].id, screenHash: 'deadbeef', option: '1' });
check('stale hash is refused', !wrong.ok && wrong.error === 'prompt_changed', wrong);
const bad = hub.answer('t1', { approvalId: items[0].id, screenHash: items[0].screenHash, option: '7' });
check('unknown option is refused', !bad.ok && bad.error === 'bad_option', bad);
const good = hub.answer('t1', { approvalId: items[0].id, screenHash: items[0].screenHash, option: '2' });
check('matching answer returns the option key', good.ok && good.keys === '2', good);
check('answered prompt is cleared', !hub.get('t1').approval);
await sleep(900);
check('answered prompt still on screen is not re-raised', !hub.get('t1').approval);

hub.data('t1', '\x1b[2J\x1b[HRan npm test\r\n');
await sleep(3200);
check('quiet terminal turns idle', hub.status('t1') === 'idle', hub.status('t1'));
check('summary tracks the last output', hub.get('t1').summary === 'Ran npm test', hub.get('t1').summary);

const screen = hub.screen('t1');
check('screen() serializes the headless buffer', screen.data.includes('Ran npm test') && screen.seq === hub.get('t1').seq);

hub.exit('t1', 1);
check('abnormal exit shows up in attention', hub.attention(() => ({ name: 'x', spaceId: 'w' }))[0]?.kind === 'exited');
hub.start('t1', { cols: 60, rows: 12, pid: 2 });
check('restart under the same id resets the session', hub.get('t1').seq === 0 && hub.status('t1') === 'working');
hub.stop('t1');
check('stop forgets the session', hub.get('t1') === null);

console.log(failures ? `\nHUB: ${failures} FAILURE(S)` : '\nHUB: ALL PASSED');
process.exit(failures ? 1 : 0);
