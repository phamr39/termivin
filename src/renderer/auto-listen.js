// Auto-listen: an opt-in per-terminal mechanism that types
// `termivin recv --wait 60\r` into an agent's pane whenever mail lands in
// its bus queue, so an agent that forgot to poll picks the message up.
//
// The safety story is the whole point of this module. An unattended Enter
// into a pane can approve a permission prompt, cancel a long-running task, or
// submit a half-typed message; so before nudging we check every guard we know:
//
//   * autoListen is on for this terminal (opt-in)
//   * an agent CLI, not an external window or a bare shell
//   * process is running
//   * status is idle (not working, not approval) — the prompt is stable
//   * pane has been quiet for at least IDLE_MIN_MS — belt and braces for
//     "status just flipped idle a moment ago while a redraw was in flight"
//   * we haven't nudged this pane in the last NUDGE_COOLDOWN_MS — every
//     nudge starts a 60-second poll, so nudging twice in a burst is wasteful
//     and can double-drain the queue if the first recv landed just before
//     the second nudge got typed
//
// A separate coalescer collapses bursts: if five messages arrive in quick
// succession, only one nudge fires (the first recv drains all five).

import * as S from './state.js';
import * as TM from './term-manager.js';
import { isAgentType } from './presets.js';

// All dependencies routed through a single object so a Node test can swap them
// out — TM.getStatus and friends read from the renderer's xterm runtimes,
// which don't exist under `node test/…`, so a straight import in a test file
// can't exercise the guard logic without a real Electron process.
const deps = {
  findTerminal: (id) => S.findTerminal(id),
  setAutoListen: (id, on) => S.setAutoListen(id, on),
  getStatus: (id) => TM.getStatus(id),
  isRunning: (id) => TM.isRunning(id),
  idleForMs: (id) => TM.idleForMs(id),
  sendKeys: (id, data) => TM.sendKeys(id, data),
  isAgentType: (type) => isAgentType(type),
  now: () => Date.now(),
  scheduleTimer: (fn, ms) => setTimeout(fn, ms),
  clearScheduledTimer: (t) => clearTimeout(t),
};

// Public: swap any of the above for tests. Production callers never touch this.
export function __setDepsForTests(overrides) {
  Object.assign(deps, overrides);
}

// Public: reset internal state — used between test cases so cooldowns and
// pending-nudge sets from a previous scenario don't leak into the next one.
export function __resetForTests() {
  for (const timer of pending.values()) deps.clearScheduledTimer(timer);
  pending.clear();
  lastNudgeAt.clear();
  wantsNudge.clear();
}

const IDLE_MIN_MS = 8000;
const NUDGE_COOLDOWN_MS = 30000;
const COALESCE_MS = 400;

// termId -> timestamp of the last nudge we sent (successful or attempted)
const lastNudgeAt = new Map();
// termId -> setTimeout handle for a coalesced nudge waiting to fire
const pending = new Map();
// termIds we owe a nudge to — set on a 'mail' event, cleared once the agent
// actually drains the queue ('read'). Nudging on status change too means that
// mail which arrived while the agent was working is picked up the moment the
// agent goes quiet, instead of waiting for another message.
const wantsNudge = new Set();

// Public: subscribe to bus events. Ui.js wires this up alongside its own
// listeners so we run inside the renderer's normal message-event flow.
export function handleBusEvent(evt) {
  if (!evt) return;
  if (evt.type === 'mail') {
    wantsNudge.add(evt.to);
    scheduleNudge(evt.to);
  } else if (evt.type === 'read') {
    wantsNudge.delete(evt.by);
    // Successful drain: let the cooldown reset immediately so the next mail
    // fires straight away instead of waiting the full 30s.
    lastNudgeAt.delete(evt.by);
  }
}

// Public: term-manager status change hook. On any status change we take the
// chance to fire a nudge that was queued while the agent was busy.
export function handleStatusChange(termId) {
  if (wantsNudge.has(termId)) scheduleNudge(termId);
}

// Public: prime the wantsNudge set from a stats snapshot — used once at boot
// and after every stats refresh, so mail that piled up during the app being
// closed doesn't sit there silently until the next new message arrives.
export function seedFromStats(agents) {
  if (!agents) return;
  for (const a of agents) {
    if (a.pending > 0) {
      if (!wantsNudge.has(a.id)) {
        wantsNudge.add(a.id);
        scheduleNudge(a.id);
      }
    }
  }
}

function scheduleNudge(termId) {
  if (pending.has(termId)) return; // a nudge is already queued for this pane
  const timer = deps.scheduleTimer(() => {
    pending.delete(termId);
    maybeNudge(termId);
  }, COALESCE_MS);
  pending.set(termId, timer);
}

function maybeNudge(termId) {
  const found = deps.findTerminal(termId);
  if (!found) return;
  const { meta } = found;
  if (!meta.autoListen) return;
  if (meta.external) return;
  if (!deps.isAgentType(meta.type)) return;
  if (!deps.isRunning(termId)) return;
  const status = deps.getStatus(termId);
  if (status !== 'idle') return; // working / approval / exited / saved all bail
  if (deps.idleForMs(termId) < IDLE_MIN_MS) return;
  const last = lastNudgeAt.get(termId) || 0;
  if (deps.now() - last < NUDGE_COOLDOWN_MS) return;

  lastNudgeAt.set(termId, deps.now());
  // With Enter this time — auto-listen is the whole feature, and the guards
  // above are what earn the right to press it. The manual Push button in the
  // dashboard row menu still types without Enter for the more conservative
  // case where the user is in the loop.
  deps.sendKeys(termId, 'termivin recv --wait 60\r');
}

// Public: manual toggle. Called by pane menu + dashboard row menu.
export function setAutoListen(termId, on) {
  const ok = deps.setAutoListen(termId, on);
  if (!ok) return false;
  // Clear the cooldown so turning on auto-listen makes the *next* mail act
  // right away, even if the user manually pushed 15 seconds ago.
  if (on) lastNudgeAt.delete(termId);
  return true;
}

export function isAutoListen(termId) {
  const found = deps.findTerminal(termId);
  return !!(found && found.meta.autoListen);
}

// Called when a terminal is removed so we don't leak the pending timer or the
// cooldown map — trivial memory, but stale entries around a reused termId
// would silently mute the first nudge after a restore.
export function forgetTerminal(termId) {
  const timer = pending.get(termId);
  if (timer) {
    deps.clearScheduledTimer(timer);
    pending.delete(termId);
  }
  lastNudgeAt.delete(termId);
}
