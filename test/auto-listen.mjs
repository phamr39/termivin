// Unit exercise of src/renderer/auto-listen.js — the module that decides
// when (and whether) to type `termivin recv --wait 60\r` into an agent's
// pane. The renderer's real state.js and term-manager.js are hard to stand up
// under Node (they need window.termivin, xterm, and a DOM), so the module
// exposes __setDepsForTests / __resetForTests for exactly this suite: swap the
// dependency shims for observable fakes and drive the state machine directly.
//
// Run with: npm run test:auto-listen

import { fileURLToPath } from 'url';
import path from 'path';

// presets.js reads window.termivin.platform at module-load time, so stub the
// bare minimum before any renderer import runs.
globalThis.window = globalThis.window || {
  termivin: {
    platform: 'linux',
    homedir: '/home/test',
    saveState: () => true,
    ptyWrite: () => {},
  },
};

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const AL = await import(path.join(ROOT, 'src', 'renderer', 'auto-listen.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name +
    (cond ? '' : '  → ' + JSON.stringify(detail)));
  if (!cond) fails++;
};

// --- fake world ---------------------------------------------------------
// A single fake terminal that every test seeds; each test resets it to sane
// defaults. sendCalls captures what auto-listen typed into the pane so we can
// assert whether a nudge fired at all.
let world;
let sendCalls;
let clock;

function resetWorld() {
  world = {
    id: 't1',
    autoListen: true,
    external: false,
    type: 'claude',
    running: true,
    status: 'idle',
    idleForMs: 20000,
  };
  sendCalls = [];
  clock = 1_700_000_000_000; // fixed baseline so cooldown checks are stable
  AL.__resetForTests();
  AL.__setDepsForTests({
    findTerminal: (id) => (id === world.id ? { meta: world } : null),
    setAutoListen: (id, on) => (id === world.id ? (world.autoListen = !!on, true) : false),
    getStatus: (id) => (id === world.id ? world.status : null),
    isRunning: (id) => (id === world.id ? world.running : false),
    idleForMs: (id) => (id === world.id ? world.idleForMs : Infinity),
    sendKeys: (id, data) => sendCalls.push({ id, data }),
    isAgentType: (type) => type === 'claude' || type === 'codex',
    now: () => clock,
    // Sync timers so the coalesce delay resolves inside our fake clock; the
    // real setTimeout would race with `await new Promise(setImmediate)` and
    // make burst tests flaky.
    scheduleTimer: (fn) => {
      const handle = { fn, cancelled: false };
      queueMicrotask(() => { if (!handle.cancelled) fn(); });
      return handle;
    },
    clearScheduledTimer: (t) => { if (t) t.cancelled = true; },
  });
}

const flush = () => new Promise((r) => queueMicrotask(r));

// --- test cases ---------------------------------------------------------

// 1) Every guard passes → the recv command with a trailing \r is typed once.
resetWorld();
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('nudges when every guard passes',
  sendCalls.length === 1 && sendCalls[0].data === 'termivin recv --wait 60\r',
  sendCalls);

// 2) autoListen off → nothing typed.
resetWorld();
world.autoListen = false;
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge when autoListen is off', sendCalls.length === 0, sendCalls);

// 3) status "working" → skipped (Enter would interrupt a running task).
resetWorld();
world.status = 'working';
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge while status is working', sendCalls.length === 0, sendCalls);

// 4) status "approval" → skipped (Enter would answer the prompt).
resetWorld();
world.status = 'approval';
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge at an approval prompt', sendCalls.length === 0, sendCalls);

// 5) not running → skipped.
resetWorld();
world.running = false;
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge a stopped terminal', sendCalls.length === 0, sendCalls);

// 6) idle < 8s → skipped (prompt might not be stable).
resetWorld();
world.idleForMs = 1000;
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge before IDLE_MIN_MS elapsed', sendCalls.length === 0, sendCalls);

// 7) Non-agent type (bare shell) → skipped.
resetWorld();
world.type = 'shell';
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge a non-agent terminal', sendCalls.length === 0, sendCalls);

// 8) External window → skipped.
resetWorld();
world.external = { hwnd: 42 };
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('does not nudge an external window', sendCalls.length === 0, sendCalls);

// 9) Burst of mail events → coalesced into one nudge.
resetWorld();
AL.handleBusEvent({ type: 'mail', to: 't1' });
AL.handleBusEvent({ type: 'mail', to: 't1' });
AL.handleBusEvent({ type: 'mail', to: 't1' });
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('coalesces a burst of mail into a single nudge',
  sendCalls.length === 1, sendCalls.length);

// 10) A second mail inside NUDGE_COOLDOWN_MS after a successful nudge → skipped.
resetWorld();
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
clock += 5000; // 5s later — well within the 30s cooldown
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('respects the nudge cooldown', sendCalls.length === 1, sendCalls.length);

// 11) A 'read' event resets the cooldown so the next mail fires immediately.
resetWorld();
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
AL.handleBusEvent({ type: 'read', by: 't1' });
clock += 100; // barely any wall-time
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('read event clears cooldown so next mail can nudge',
  sendCalls.length === 2, sendCalls.length);

// 12) Mail arrives while agent is busy; when status flips to idle,
//     handleStatusChange fires the nudge — this is the whole "agent went deaf
//     because it was busy" repair.
resetWorld();
world.status = 'working';
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('waits during busy: no nudge yet', sendCalls.length === 0, sendCalls);
world.status = 'idle';
AL.handleStatusChange('t1');
await flush();
check('fires the deferred nudge as soon as terminal turns idle',
  sendCalls.length === 1, sendCalls);

// 13) Status changes without pending nudge → no spurious send.
resetWorld();
AL.handleStatusChange('t1');
await flush();
check('status change alone does not nudge', sendCalls.length === 0, sendCalls);

// 14) seedFromStats populates wantsNudge from server pending counts.
resetWorld();
AL.seedFromStats([{ id: 't1', pending: 3 }]);
await flush();
check('seedFromStats nudges agents with pending mail after boot',
  sendCalls.length === 1, sendCalls);

// 15) seedFromStats respects pending === 0.
resetWorld();
AL.seedFromStats([{ id: 't1', pending: 0 }]);
await flush();
check('seedFromStats skips agents with no pending', sendCalls.length === 0, sendCalls);

// 16) setAutoListen persists via the state hook.
resetWorld();
world.autoListen = false;
const ok = AL.setAutoListen('t1', true);
check('setAutoListen returns true on success', ok === true, ok);
check('setAutoListen writes into state', world.autoListen === true, world.autoListen);

// 17) isAutoListen mirrors state.
resetWorld();
world.autoListen = true;
check('isAutoListen true when on', AL.isAutoListen('t1') === true);
world.autoListen = false;
check('isAutoListen false when off', AL.isAutoListen('t1') === false);

// 18) forgetTerminal clears pending timers + cooldowns.
resetWorld();
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
AL.forgetTerminal('t1');
// After a forget, a mail should nudge again even inside the old cooldown.
clock += 500;
AL.handleBusEvent({ type: 'mail', to: 't1' });
await flush();
check('forgetTerminal resets cooldown', sendCalls.length === 2, sendCalls.length);

// 19) Non-'mail'/'read' bus events are ignored.
resetWorld();
AL.handleBusEvent({ type: 'msg', from: 'x', to: 't1' });
AL.handleBusEvent(null);
AL.handleBusEvent({});
await flush();
check('ignores unrelated bus events', sendCalls.length === 0, sendCalls);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
