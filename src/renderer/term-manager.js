// Terminal runtime manager: xterm instances, PTY lifecycle, status &
// approval-prompt detection, plus attached external OS windows.
// Metadata lives in state.js; this module owns everything that only exists
// while the app is running. Pane positioning/interaction lives in ui.js.

import { defaultShell, detectApproval, approvalKeys, typeInfo, isAgentType } from './presets.js';
import { findTerminal, scheduleSave, getState } from './state.js';
import { themeInfo } from './themes.js';

const runtimes = new Map(); // termId -> rt
const listeners = new Set(); // status-change subscribers
const lastNotified = new Map(); // termId -> timestamp (notification throttle)

function xtermTheme() {
  const state = getState();
  return themeInfo(state ? state.theme : 'termivin').xterm;
}

// Repaint every live terminal with the given app theme's palette — xterm
// renders to canvas, so switching the CSS theme alone would leave stale
// terminal colors behind.
export function applyXtermTheme(name) {
  const theme = themeInfo(name).xterm;
  for (const rt of runtimes.values()) {
    if (rt.xterm) {
      rt.xterm.options.theme = { ...theme };
      try { rt.xterm.refresh(0, rt.xterm.rows - 1); } catch {}
    }
  }
}

export function onStatusChange(cb) {
  listeners.add(cb);
}

function emit(termId) {
  for (const cb of listeners) cb(termId);
}

export function getRuntime(termId) {
  return runtimes.get(termId) || null;
}

// Creates the floating pane DOM + (for shell terminals) the xterm instance.
export function ensureRuntime(meta) {
  let rt = runtimes.get(meta.id);
  if (rt) return rt;

  const info = typeInfo(meta.type);
  const isExternal = !!meta.external || meta.type === 'external';
  const isAgent = !isExternal && isAgentType(meta.type);
  const pane = document.createElement('div');
  pane.className = 'pane hidden';
  pane.dataset.termId = meta.id;
  pane.innerHTML = `
    <div class="pane-bar">
      <span class="dot st-saved"></span>
      <span class="pane-icon" style="color:${info.color}">${info.icon}</span>
      <span class="pane-name"></span>
      <span class="pane-spacer"></span>
      ${isAgent ? '<button class="pane-btn pane-connect" title="Connect this agent to the workspace bus">🔗</button>' : ''}
      ${isExternal ? '' : '<button class="pane-btn pane-clone" title="Clone terminal (same folder & commands)">❐</button>'}
      <button class="pane-btn pane-more" title="More actions">⋯</button>
      <button class="pane-btn pane-min" title="Minimize to dock">−</button>
      <button class="pane-btn pane-max" title="Fullscreen">⛶</button>
      <button class="pane-btn pane-close" title="Close">×</button>
    </div>
    <div class="pane-body"></div>
    <div class="pane-overlay hidden"></div>`;
  pane.querySelector('.pane-name').textContent = meta.name;
  // Resize handles on every edge and corner (free resize, like an OS window).
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const h = document.createElement('div');
    h.className = 'pane-rs';
    h.dataset.dir = dir;
    pane.appendChild(h);
  }
  document.getElementById('panes').appendChild(pane);

  rt = {
    id: meta.id,
    pane,
    body: pane.querySelector('.pane-body'),
    external: isExternal,
    xterm: null,
    fit: null,
    running: false,
    everStarted: false,
    attached: false,
    exitCode: null,
    lastDataAt: 0,
    approval: null,
    checkTimer: null,
    protectScrollbackUntil: 0,
  };
  runtimes.set(meta.id, rt);

  if (!rt.external) {
    const xterm = new Terminal({
      fontSize: 13,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, monospace',
      theme: { ...xtermTheme() },
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
    });
    const fit = new FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
    xterm.open(rt.body);
    rt.xterm = xterm;
    rt.fit = fit;

    xterm.onData((data) => {
      if (rt.running) window.termivin.ptyWrite(meta.id, data);
    });
    xterm.onResize(({ cols, rows }) => {
      if (rt.running) window.termivin.ptyResize(meta.id, cols, rows);
    });

    // --- clipboard ---------------------------------------------------------
    // Ctrl+V already works (Electron's default Edit menu pastes into xterm's
    // helper textarea), but Ctrl+C never reaches the menu: xterm claims it and
    // sends SIGINT, so a selection can never be copied. Adopt the Windows
    // Terminal convention — with a selection Ctrl+C copies, without one it
    // still interrupts — and add the explicit Ctrl+Shift+C/V pair.
    const copySelection = () => {
      const text = xterm.getSelection();
      if (!text) return false;
      window.termivin.clipboardWrite(text);
      xterm.clearSelection(); // so the very next Ctrl+C interrupts again
      return true;
    };
    const pasteClipboard = async () => {
      const text = await window.termivin.clipboardRead();
      if (text) xterm.paste(text); // xterm.paste respects bracketed-paste mode
    };
    rt.copySelection = copySelection;
    rt.pasteClipboard = pasteClipboard;

    const isMac = window.termivin.platform === 'darwin';
    xterm.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (!(isMac ? e.metaKey : e.ctrlKey)) return true;
      const key = (e.key || '').toLowerCase();
      if (key === 'c' && (e.shiftKey || xterm.hasSelection())) {
        copySelection();
        return false;
      }
      if (key === 'v' && e.shiftKey) {
        pasteClipboard();
        return false;
      }
      return true;
    });

    // Mouse-only path, same convention: right-click copies a selection,
    // otherwise it pastes.
    rt.body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (xterm.hasSelection()) {
        copySelection();
        return;
      }
      // When the app in the terminal captures the mouse (Claude Code sets
      // mouse tracking "any"), xterm has already reported this right-click to
      // it — and Claude Code pastes the clipboard by itself on right-click.
      // Pasting here too would insert the text twice, so defer to the app.
      if (xterm.modes.mouseTrackingMode !== 'none') return;
      pasteClipboard();
    });

    // Refit whenever the floating pane is resized.
    let fitRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(() => {
        if (!pane.classList.contains('hidden')) {
          try { fit.fit(); } catch {}
        }
      });
    });
    ro.observe(rt.body);
    rt.resizeObserver = ro;
  } else {
    rt.body.classList.add('external-body');
    rt.body.innerHTML = '<div class="external-note">External window</div>';
  }

  return rt;
}

export function initPtyEvents() {
  window.termivin.onPtyData((termId, data) => {
    const rt = runtimes.get(termId);
    if (!rt || !rt.xterm) return;
    // ConPTY clears scrollback (ESC[3J) during startup, which would wipe the
    // restored-session replay. Strip it for a short window after spawn.
    if (rt.protectScrollbackUntil && Date.now() < rt.protectScrollbackUntil) {
      data = data.replace(/\x1b\[3J/g, '');
    }
    rt.xterm.write(data);
    rt.lastDataAt = Date.now();
    if (rt.approval) {
      rt.approval = null;
      emit(termId);
    }
    clearTimeout(rt.checkTimer);
    rt.checkTimer = setTimeout(() => checkApproval(termId), 700);
  });

  window.termivin.onPtyExit((termId, code) => {
    const rt = runtimes.get(termId);
    if (!rt || !rt.xterm) return;
    rt.running = false;
    rt.exitCode = code;
    rt.approval = null;
    rt.xterm.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
    saveTail(termId);
    emit(termId);
  });
}

function checkApproval(termId) {
  const rt = runtimes.get(termId);
  if (!rt || !rt.running || !rt.xterm) return;
  const lines = readTail(rt, 30);
  const found = detectApproval(lines);
  if (found) {
    rt.approval = found;
    emit(termId);
    maybeNotify(termId);
  }
}

function maybeNotify(termId) {
  const found = findTerminal(termId);
  if (!found) return;
  const last = lastNotified.get(termId) || 0;
  if (Date.now() - last < 30000) return;
  lastNotified.set(termId, Date.now());
  try {
    new Notification('Termivin — approval needed', {
      body: `"${found.meta.name}" in workspace "${found.ws.name}" is waiting for your approval.`,
    });
  } catch {}
}

function readTail(rt, n) {
  // The bottom of the viewport is usually blank rows — scan a generous
  // window, drop trailing blanks, then take the last n meaningful lines.
  const buf = rt.xterm.buffer.active;
  const total = buf.length;
  const lines = [];
  for (let i = Math.max(0, total - 400); i < total; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-n);
}

// --- Public API -----------------------------------------------------------

export async function spawnTerminal(meta, { useRestore = false } = {}) {
  const rt = ensureRuntime(meta);
  if (rt.external) return { ok: false, error: 'external windows cannot be spawned' };
  if (rt.running) return { ok: true };

  // Size the terminal to its pane BEFORE spawning the PTY. Panes keep their
  // layout even when hidden, so fit() works here — and it avoids a post-spawn
  // resize, which makes ConPTY repaint the viewport (wiping the replay).
  try { rt.fit.fit(); } catch {}

  const shell = meta.shell || defaultShell();
  const command = useRestore ? (meta.restoreCommand || meta.command) : meta.command;

  rt.running = true;
  rt.everStarted = true;
  rt.exitCode = null;
  rt.approval = null;
  rt.lastDataAt = Date.now();

  if (useRestore && meta.savedTail && meta.savedTail.length) {
    rt.xterm.write('\x1b[90m── previous session ──\x1b[0m\r\n');
    for (const line of meta.savedTail.slice(-20)) {
      rt.xterm.write('\x1b[90m' + line + '\x1b[0m\r\n');
    }
    rt.xterm.write('\x1b[90m── restored (scroll up for history) ──\x1b[0m\r\n');
    // Push the replay into scrollback: ConPTY (and some shells) clear the
    // viewport on startup, which would otherwise wipe these lines.
    rt.xterm.write('\r\n'.repeat(rt.xterm.rows));
    rt.protectScrollbackUntil = Date.now() + 4000;
  }

  const found = findTerminal(meta.id);
  const res = await window.termivin.ptyCreate({
    id: meta.id,
    shell,
    cwd: meta.cwd,
    command,
    cols: rt.xterm.cols,
    rows: rt.xterm.rows,
    // Agent-bus identity, injected into the shell's environment.
    space: found ? found.ws.id : null,
    name: meta.name,
  });

  if (!res.ok) {
    rt.running = false;
    rt.exitCode = -1;
    rt.xterm.write(`\r\n\x1b[31mFailed to start: ${res.error}\x1b[0m\r\n`);
  }
  emit(meta.id);
  return res;
}

export function stopTerminal(termId) {
  const rt = runtimes.get(termId);
  if (rt && rt.running) {
    saveTail(termId);
    window.termivin.ptyKill(termId);
    rt.running = false;
    rt.exitCode = rt.exitCode == null ? 0 : rt.exitCode;
    emit(termId);
  }
}

export function disposeTerminal(termId) {
  const rt = runtimes.get(termId);
  if (!rt) return;
  if (rt.running) window.termivin.ptyKill(termId);
  if (rt.attached) {
    const found = findTerminal(termId);
    if (found && found.meta.external) {
      window.termivin.externalDetach({
        hwnd: found.meta.external.hwnd,
        origStyle: found.meta.external.origStyle ?? null,
      });
    }
    rt.attached = false;
  }
  clearTimeout(rt.checkTimer);
  if (rt.resizeObserver) rt.resizeObserver.disconnect();
  try { rt.xterm && rt.xterm.dispose(); } catch {}
  rt.pane.remove();
  runtimes.delete(termId);
  lastNotified.delete(termId);
}

export function markAttached(termId, attached) {
  const found = findTerminal(termId);
  const rt = found ? ensureRuntime(found.meta) : runtimes.get(termId);
  if (rt) {
    rt.attached = attached;
    emit(termId);
  }
}

export function isAttached(termId) {
  const rt = runtimes.get(termId);
  return !!(rt && rt.attached);
}

export function getStatus(termId) {
  const rt = runtimes.get(termId);
  if (rt && rt.external) return rt.attached ? 'attached' : 'saved';
  if (!rt || !rt.everStarted) return 'saved';
  if (rt.running) {
    if (rt.approval) return 'approval';
    return Date.now() - rt.lastDataAt < 3000 ? 'working' : 'idle';
  }
  return 'exited';
}

export function getApproval(termId) {
  const rt = runtimes.get(termId);
  return rt ? rt.approval : null;
}

export function isRunning(termId) {
  const rt = runtimes.get(termId);
  return !!(rt && (rt.running || rt.attached));
}

export function approve(termId, yes) {
  const rt = runtimes.get(termId);
  if (!rt || !rt.running || !rt.approval) return;
  window.termivin.ptyWrite(termId, approvalKeys(rt.approval.kind, yes));
  rt.approval = null;
  emit(termId);
}

export function sendKeys(termId, data) {
  const rt = runtimes.get(termId);
  if (rt && rt.running) window.termivin.ptyWrite(termId, data);
}

export function getPreview(termId, n = 14) {
  const rt = runtimes.get(termId);
  if (rt && rt.external) return [];
  if (rt && rt.everStarted && rt.xterm) {
    return readTail(rt, n);
  }
  const found = findTerminal(termId);
  if (found && found.meta.savedTail && found.meta.savedTail.length) {
    return found.meta.savedTail.slice(-n);
  }
  return [];
}

export function focusTerminal(termId) {
  const rt = runtimes.get(termId);
  if (rt && rt.xterm) rt.xterm.focus();
}

export function fitTerminal(termId) {
  const rt = runtimes.get(termId);
  if (rt && rt.fit && !rt.pane.classList.contains('hidden')) {
    try { rt.fit.fit(); } catch {}
  }
}

// Recover a terminal that has gone sluggish or is drawing garbage after a long
// session: drop the cached glyph atlas, re-measure against the pane, tell the
// PTY the size again (so the shell repaints its prompt) and force a repaint.
export function refreshTerminal(termId) {
  const rt = runtimes.get(termId);
  if (!rt || !rt.xterm) return false;
  try { rt.xterm.clearTextureAtlas?.(); } catch {}
  try { rt.fit.fit(); } catch {}
  if (rt.running) window.termivin.ptyResize(termId, rt.xterm.cols, rt.xterm.rows);
  try { rt.xterm.refresh(0, rt.xterm.rows - 1); } catch {}
  rt.xterm.scrollToBottom();
  rt.xterm.focus();
  return true;
}

// The actual cure when a terminal has slowed down — 8000 lines of scrollback is
// a lot of state to keep live. Keeps the visible screen, drops the history.
export function clearScrollback(termId) {
  const rt = runtimes.get(termId);
  if (!rt || !rt.xterm) return false;
  rt.xterm.clear();
  refreshTerminal(termId);
  return true;
}

export function fitAllVisible() {
  for (const rt of runtimes.values()) {
    if (rt.fit && !rt.pane.classList.contains('hidden')) {
      try { rt.fit.fit(); } catch {}
    }
  }
}

export function saveTail(termId) {
  const rt = runtimes.get(termId);
  const found = findTerminal(termId);
  if (!rt || !found || !rt.everStarted || !rt.xterm) return;
  found.meta.savedTail = readTail(rt, 40);
  scheduleSave();
}

export function saveAllTails() {
  for (const rt of runtimes.values()) {
    if (rt.everStarted && rt.xterm) saveTail(rt.id);
  }
}
