// All DOM rendering & interactions: sidebar, tabs, floating canvas,
// dashboard, modals, drag&drop, external-window embedding.

import * as S from './state.js';
import * as TM from './term-manager.js';
import { TYPES, typeInfo, randomWorkspaceName, randomTerminalName } from './presets.js';

const $ = (sel) => document.querySelector(sel);
const isWin = window.termivin.platform === 'win32';

const STATUS_LABEL = {
  saved: 'saved',
  working: 'working',
  idle: 'idle',
  approval: 'needs approval',
  exited: 'exited',
  attached: 'attached',
};

// ---------------------------------------------------------------- helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function inlineRename(span, current, onDone) {
  const input = el('input', 'inline-rename');
  input.type = 'text';
  input.value = current;
  span.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    // Put the original span back — not every caller rebuilds its DOM.
    span.textContent = commit && input.value.trim() ? input.value.trim() : current;
    input.replaceWith(span);
    onDone(commit ? input.value : null);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

function shortPath(p) {
  if (!p) return '';
  const home = window.termivin.homedir;
  let out = p.startsWith(home) ? '~' + p.slice(home.length) : p;
  if (out.length > 38) out = '…' + out.slice(-37);
  return out;
}

function closeOrRemoveTerminal(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  const t = found.meta;
  if (t.external) {
    if (!confirm(`Detach "${t.name}" (the window returns to the desktop) and remove it from the workspace?`)) return;
    detachExternal(termId, { remove: true });
    return;
  }
  const running = TM.isRunning(termId);
  const msg = running
    ? `Close terminal "${t.name}"? The running process will be stopped and the terminal removed from the workspace.`
    : `Remove terminal "${t.name}" from the workspace?`;
  if (!confirm(msg)) return;
  TM.disposeTerminal(termId);
  S.removeTerminal(termId);
  renderAll();
}

// ---------------------------------------------------------------- sidebar

function wsCounts(ws) {
  let approvals = 0;
  let running = 0;
  for (const t of ws.terminals) {
    const st = TM.getStatus(t.id);
    if (st === 'approval') approvals++;
    if (st === 'approval' || st === 'working' || st === 'idle' || st === 'attached') running++;
  }
  return { approvals, running };
}

export function renderSidebar() {
  const list = $('#workspace-list');
  list.innerHTML = '';
  const state = S.getState();

  for (const ws of state.workspaces) {
    const item = el('div', 'ws-item' + (ws.id === state.activeWorkspaceId ? ' active' : ''));
    item.dataset.wsId = ws.id;

    const name = el('span', 'ws-name', ws.name);
    const badges = el('span', 'ws-badges');
    fillBadges(badges, ws);

    const ren = el('button', 'ws-ren', '✎');
    ren.title = 'Rename workspace';
    const del = el('button', 'ws-del', '×');
    del.title = 'Delete workspace';

    item.append(name, badges, ren, del);
    list.appendChild(item);

    const startRename = () => {
      inlineRename(name, ws.name, (val) => {
        if (val) S.renameWorkspace(ws.id, val);
        renderSidebar();
        renderHeader();
      });
    };

    item.addEventListener('click', (e) => {
      if (e.target === del || e.target === ren) return;
      if (ws.id === S.getState().activeWorkspaceId) return; // keep DOM stable so dblclick-rename works
      S.setActiveWorkspace(ws.id);
      renderAll();
      autoRestoreWorkspace(ws.id); // first visit after startup revives saved terminals
    });

    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename();
    });

    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename();
    });

    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = ws.terminals.length;
      const msg = n
        ? `Delete workspace "${ws.name}" and its ${n} terminal(s)? Running processes will be stopped.`
        : `Delete workspace "${ws.name}"?`;
      if (!confirm(msg)) return;
      const orphans = S.removeWorkspace(ws.id);
      for (const t of orphans) TM.disposeTerminal(t.id);
      renderAll();
    });

    // Drop target for terminal tabs
    item.addEventListener('dragover', (e) => {
      if (dragTermId) {
        e.preventDefault();
        item.classList.add('drop-target');
      }
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target');
      if (dragTermId) {
        S.moveTerminal(dragTermId, ws.id);
        renderAll();
      }
    });
  }
}

function fillBadges(badges, ws) {
  const { approvals, running } = wsCounts(ws);
  badges.innerHTML = '';
  if (approvals) badges.appendChild(el('span', 'badge badge-approval', String(approvals)));
  if (running) badges.appendChild(el('span', 'badge badge-run', String(running)));
  badges.appendChild(el('span', 'badge badge-total', String(ws.terminals.length)));
}

function renderSidebarBadges() {
  for (const ws of S.getState().workspaces) {
    const item = document.querySelector(`.ws-item[data-ws-id="${ws.id}"]`);
    if (item) fillBadges(item.querySelector('.ws-badges'), ws);
  }
}

// ---------------------------------------------------------------- header

export function renderHeader() {
  const ws = S.activeWorkspace();
  $('#ws-title').textContent = ws ? ws.name : '';

  for (const btn of document.querySelectorAll('#view-toggle .seg-btn')) {
    btn.classList.toggle('active', ws && btn.dataset.view === ws.view);
  }

  const anySaved = ws && ws.terminals.some((t) => !t.external && !TM.isRunning(t.id));
  $('#ws-restore-btn').classList.toggle('hidden', !ws || !anySaved);
  $('#attach-window-btn').classList.toggle('hidden', !isWin);
}

// ---------------------------------------------------------------- tabs

let dragTermId = null;

export function renderTabs() {
  const bar = $('#tabbar');
  bar.innerHTML = '';
  const ws = S.activeWorkspace();
  if (!ws) return;

  for (const t of ws.terminals) {
    const info = typeInfo(t.external ? 'external' : t.type);
    const tab = el('div', 'tab' + (t.id === ws.activeTerminalId ? ' active' : ''));
    tab.dataset.termId = t.id;
    tab.draggable = true;

    const dot = el('span', 'dot st-' + TM.getStatus(t.id));
    const icon = el('span', 'tab-icon', info.icon);
    icon.style.color = info.color;
    const name = el('span', 'tab-name', t.name);
    const close = el('span', 'tab-close', '×');
    close.title = 'Close & remove terminal';
    tab.append(dot, icon, name, close);
    bar.appendChild(tab);

    tab.addEventListener('click', (e) => {
      if (e.target === close) return;
      // Light path when the tab is already active: keep the DOM stable so a
      // double-click reaches the rename handler.
      if (t.id === ws.activeTerminalId && ws.view === 'canvas') {
        S.bringToFront(t.id);
        const rt = TM.getRuntime(t.id);
        if (rt && !ws.fullscreenTerminalId) rt.pane.style.zIndex = t.layout.z;
        TM.focusTerminal(t.id);
        return;
      }
      ws.activeTerminalId = t.id;
      if (ws.view !== 'canvas') ws.view = 'canvas';
      if (ws.fullscreenTerminalId) ws.fullscreenTerminalId = t.id;
      S.bringToFront(t.id);
      S.scheduleSave();
      renderAll();
      TM.focusTerminal(t.id);
    });

    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      inlineRename(name, t.name, (val) => {
        if (val) S.renameTerminal(t.id, val);
        renderTabs();
        renderDashboard();
        updatePanes();
      });
    });

    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOrRemoveTerminal(t.id);
    });

    tab.addEventListener('dragstart', (e) => {
      dragTermId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => {
      dragTermId = null;
      tab.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    });

    tab.addEventListener('dragover', (e) => {
      if (dragTermId && dragTermId !== t.id) {
        e.preventDefault();
        tab.classList.add('drop-target');
      }
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-target'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drop-target');
      if (dragTermId && dragTermId !== t.id) {
        S.moveTerminal(dragTermId, ws.id, t.id);
        renderAll();
      }
    });
  }
}

// Auto-restore: terminals still in the "saved" state (from a previous
// session) spawn automatically when their workspace is opened. Terminals the
// user stopped mid-session are "exited", not "saved", so they stay stopped.
export async function autoRestoreWorkspace(wsId) {
  const ws = S.getWorkspace(wsId);
  if (!ws) return;
  const pending = ws.terminals.filter(
    (t) => t.autoRestore && !t.external && TM.getStatus(t.id) === 'saved'
  );
  if (!pending.length) return;
  for (const t of pending) {
    if (TM.getStatus(t.id) === 'saved') {
      await TM.spawnTerminal(t, { useRestore: true });
    }
  }
  renderAll();
}

// ---------------------------------------------------------------- canvas

export function renderContent() {
  const ws = S.activeWorkspace();
  const dash = $('#dashboard');
  const empty = $('#empty-state');
  const tabwrap = $('#tabbar-wrap');
  const content = $('#content');

  const allRts = () => {
    const ids = new Set();
    for (const w of S.getState().workspaces) for (const t of w.terminals) ids.add(t.id);
    return ids;
  };

  if (!ws || !ws.terminals.length) {
    dash.classList.add('hidden');
    tabwrap.classList.add('hidden');
    empty.classList.remove('hidden');
    hideAllPanes();
    syncExternalRects();
    return;
  }

  empty.classList.add('hidden');
  tabwrap.classList.remove('hidden');

  if (ws.view === 'dashboard') {
    dash.classList.remove('hidden');
    hideAllPanes();
    renderDashboard();
    syncExternalRects();
    return;
  }

  // canvas view
  dash.classList.add('hidden');
  content.classList.add('canvas-mode');

  if (!ws.activeTerminalId || !ws.terminals.find((t) => t.id === ws.activeTerminalId)) {
    ws.activeTerminalId = ws.terminals[0] ? ws.terminals[0].id : null;
  }
  if (ws.fullscreenTerminalId && !ws.terminals.find((t) => t.id === ws.fullscreenTerminalId)) {
    ws.fullscreenTerminalId = null;
  }

  const activeIds = new Set(ws.terminals.map((t) => t.id));
  const fsId = ws.fullscreenTerminalId;

  for (const t of ws.terminals) {
    const rt = TM.ensureRuntime(t);
    const pane = rt.pane;
    if (fsId) {
      pane.classList.toggle('fullscreen', t.id === fsId);
      pane.classList.toggle('hidden', t.id !== fsId);
    } else {
      pane.classList.remove('fullscreen', 'hidden');
      applyLayout(pane, t.layout);
    }
    pane.classList.toggle('focused', t.id === ws.activeTerminalId);
    const maxBtn = pane.querySelector('.pane-max');
    maxBtn.textContent = t.id === fsId ? '🗗' : '⛶';
    maxBtn.title = t.id === fsId ? 'Exit fullscreen' : 'Fullscreen';
  }

  // hide panes belonging to other workspaces
  document.querySelectorAll('#panes .pane').forEach((pane) => {
    if (!activeIds.has(pane.dataset.termId)) pane.classList.add('hidden');
  });

  updatePanes();
  TM.fitAllVisible();
  syncExternalRects();
}

function hideAllPanes() {
  document.querySelectorAll('#panes .pane').forEach((p) => p.classList.add('hidden'));
}

function applyLayout(pane, layout) {
  pane.style.left = layout.x + 'px';
  pane.style.top = layout.y + 'px';
  pane.style.width = layout.w + 'px';
  pane.style.height = layout.h + 'px';
  pane.style.zIndex = layout.z;
}

export function toggleFullscreen(termId) {
  const ws = S.activeWorkspace();
  if (!ws) return;
  ws.fullscreenTerminalId = ws.fullscreenTerminalId === termId ? null : termId;
  ws.activeTerminalId = termId;
  ws.view = 'canvas';
  S.scheduleSave();
  renderAll();
  TM.focusTerminal(termId);
}

// Update pane title bars + not-running overlays (canvas view)
export function updatePanes() {
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'canvas') return;
  for (const t of ws.terminals) {
    const rt = TM.getRuntime(t.id);
    if (!rt) continue;
    const st = TM.getStatus(t.id);
    rt.pane.querySelector('.pane-bar .dot').className = 'dot st-' + st;
    const nameEl = rt.pane.querySelector('.pane-name');
    if (nameEl && nameEl.textContent !== t.name) nameEl.textContent = t.name;

    const overlay = rt.pane.querySelector('.pane-overlay');
    let want = null;
    if (t.external) want = rt.attached ? null : 'external-detached';
    else if (st === 'saved' || st === 'exited') want = st;
    if ((overlay.dataset.st || '') !== (want || '')) {
      overlay.dataset.st = want || '';
      if (!want) {
        overlay.classList.add('hidden');
        overlay.innerHTML = '';
      } else {
        overlay.classList.remove('hidden');
        buildOverlay(overlay, t, st);
      }
    }
  }
}

function buildOverlay(overlay, t, st) {
  overlay.innerHTML = '';
  const box = el('div', 'overlay-box');
  const mkBtn = (label, cls, fn) => {
    const b = el('button', 'btn ' + cls, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    box.appendChild(b);
    return b;
  };

  if (t.external) {
    box.appendChild(el('div', 'overlay-label', 'External window not attached'));
    mkBtn('⧉ Attach window…', 'btn-primary btn-sm', () => openAttachModal(t.id));
    mkBtn('⇄ Convert to terminal…', 'btn-ghost btn-sm', () => openConvertModal(t.id));
    mkBtn('Remove', 'btn-ghost btn-sm btn-danger-text', () => closeOrRemoveTerminal(t.id));
  } else if (st === 'saved') {
    box.appendChild(el('div', 'overlay-label', 'Not running'));
    if (t.restoreCommand && t.savedTail && t.savedTail.length) {
      mkBtn('↻ Resume', 'btn-primary btn-sm', () => startTerminal(t, true));
      mkBtn('▶ Fresh start', 'btn-ghost btn-sm', () => startTerminal(t, false));
    } else {
      mkBtn('▶ Start', 'btn-primary btn-sm', () => startTerminal(t, false));
    }
  } else {
    box.appendChild(el('div', 'overlay-label', 'Process exited'));
    if (t.restoreCommand) mkBtn('↻ Resume', 'btn-primary btn-sm', () => startTerminal(t, true));
    mkBtn('▶ Restart', (t.restoreCommand ? 'btn-ghost' : 'btn-primary') + ' btn-sm', () => startTerminal(t, false));
  }
  overlay.appendChild(box);
}

async function startTerminal(t, useRestore) {
  await TM.spawnTerminal(t, { useRestore });
  updatePanes();
  renderSidebarBadges();
  renderHeader();
  TM.focusTerminal(t.id);
}

// Pane interactions: bring-to-front, drag by title bar, buttons, resize save.
function setupCanvasInteractions() {
  const panes = $('#panes');
  let drag = null;

  panes.addEventListener('mousedown', (e) => {
    const pane = e.target.closest('.pane');
    if (!pane) return;
    const termId = pane.dataset.termId;
    const ws = S.activeWorkspace();
    if (!ws) return;

    if (ws.activeTerminalId !== termId) {
      ws.activeTerminalId = termId;
      renderTabsActiveOnly(ws);
    }
    S.bringToFront(termId);
    const found = S.findTerminal(termId);
    if (found && !ws.fullscreenTerminalId) pane.style.zIndex = found.meta.layout.z;
    document.querySelectorAll('#panes .pane.focused').forEach((p) => p.classList.remove('focused'));
    pane.classList.add('focused');

    if (e.target.closest('.pane-btn')) return;
    const bar = e.target.closest('.pane-bar');
    if (bar && !ws.fullscreenTerminalId && found) {
      drag = {
        meta: found.meta,
        pane,
        startX: e.clientX,
        startY: e.clientY,
        origX: found.meta.layout.x,
        origY: found.meta.layout.y,
      };
      document.body.classList.add('dragging-pane');
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const host = $('#content').getBoundingClientRect();
    let x = drag.origX + (e.clientX - drag.startX);
    let y = drag.origY + (e.clientY - drag.startY);
    x = Math.max(-drag.meta.layout.w + 120, Math.min(x, host.width - 60));
    y = Math.max(0, Math.min(y, host.height - 40));
    drag.meta.layout.x = x;
    drag.meta.layout.y = y;
    drag.pane.style.left = x + 'px';
    drag.pane.style.top = y + 'px';
    throttledSyncExternal();
  });

  window.addEventListener('mouseup', () => {
    if (drag) {
      drag = null;
      document.body.classList.remove('dragging-pane');
      S.scheduleSave();
    }
    persistPaneSizes();
    syncExternalRects();
  });

  // Persist CSS-resize size changes (native resize handle) after any mouseup
  function persistPaneSizes() {
    const ws = S.activeWorkspace();
    if (!ws || ws.view !== 'canvas' || ws.fullscreenTerminalId) return;
    let changed = false;
    for (const t of ws.terminals) {
      const rt = TM.getRuntime(t.id);
      if (!rt || rt.pane.classList.contains('hidden')) continue;
      const w = rt.pane.offsetWidth;
      const h = rt.pane.offsetHeight;
      if (w && h && (w !== t.layout.w || h !== t.layout.h)) {
        t.layout.w = w;
        t.layout.h = h;
        changed = true;
      }
    }
    if (changed) S.scheduleSave();
  }

  panes.addEventListener('click', (e) => {
    const pane = e.target.closest('.pane');
    if (!pane) return;
    const termId = pane.dataset.termId;
    if (e.target.closest('.pane-max')) toggleFullscreen(termId);
    else if (e.target.closest('.pane-close')) closeOrRemoveTerminal(termId);
  });

  panes.addEventListener('dblclick', (e) => {
    const bar = e.target.closest('.pane-bar');
    if (!bar) return;
    if (e.target.closest('.pane-btn')) return;
    const pane = e.target.closest('.pane');
    const nameEl = bar.querySelector('.pane-name');
    if (e.target === nameEl) {
      const found = S.findTerminal(pane.dataset.termId);
      if (!found) return;
      inlineRename(nameEl, found.meta.name, (val) => {
        if (val) S.renameTerminal(pane.dataset.termId, val);
        renderTabs();
        updatePanes();
      });
    } else {
      toggleFullscreen(pane.dataset.termId);
    }
  });
}

function renderTabsActiveOnly(ws) {
  document.querySelectorAll('#tabbar .tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.termId === ws.activeTerminalId);
  });
}

// ---------------------------------------------------------------- external

let syncRaf = 0;
function throttledSyncExternal() {
  cancelAnimationFrame(syncRaf);
  syncRaf = requestAnimationFrame(syncExternalRects);
}

export function syncExternalRects() {
  if (!isWin) return;
  const state = S.getState();
  const active = S.activeWorkspace();
  const dpr = window.devicePixelRatio || 1;

  for (const ws of state.workspaces) {
    for (const t of ws.terminals) {
      if (!t.external || !TM.isAttached(t.id)) continue;
      const rt = TM.getRuntime(t.id);
      const visible =
        ws === active &&
        ws.view === 'canvas' &&
        rt &&
        !rt.pane.classList.contains('hidden');
      if (!visible) {
        window.termivin.externalShow({ hwnd: t.external.hwnd, visible: false });
        continue;
      }
      const r = rt.body.getBoundingClientRect();
      window.termivin.externalShow({ hwnd: t.external.hwnd, visible: true });
      window.termivin.externalMove({
        hwnd: t.external.hwnd,
        x: Math.round(r.left * dpr),
        y: Math.round(r.top * dpr),
        w: Math.round(r.width * dpr),
        h: Math.round(r.height * dpr),
      });
    }
  }
}

async function detachExternal(termId, { remove = false } = {}) {
  const found = S.findTerminal(termId);
  if (!found || !found.meta.external) return;
  await window.termivin.externalDetach({
    hwnd: found.meta.external.hwnd,
    origStyle: found.meta.external.origStyle ?? null,
  });
  TM.markAttached(termId, false);
  if (remove) {
    TM.disposeTerminal(termId);
    S.removeTerminal(termId);
  }
  renderAll();
}

// Periodically verify attached windows still exist (user may close them)
export async function checkExternalAlive() {
  if (!isWin) return;
  for (const ws of S.getState().workspaces) {
    for (const t of ws.terminals) {
      if (t.external && TM.isAttached(t.id)) {
        const alive = await window.termivin.externalAlive(t.external.hwnd);
        if (!alive) {
          TM.markAttached(t.id, false);
          updatePanes();
          renderSidebarBadges();
        }
      }
    }
  }
}

// --- attach picker modal ---

let attachTargetTermId = null; // re-attach target, or null for new terminal
let attachArmed = false; // one click of "Attach window" = exactly one attach

function setupAttachModal() {
  $('#attach-window-btn').addEventListener('click', () => openAttachModal(null));
  $('#attach-cancel').addEventListener('click', closeAttachModal);
  $('#attach-refresh').addEventListener('click', loadAttachList);
  $('#attach-all').addEventListener('change', loadAttachList);
  $('#attach-overlay').addEventListener('click', (e) => {
    if (e.target === $('#attach-overlay')) closeAttachModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#attach-overlay').classList.contains('hidden')) closeAttachModal();
  });
}

export function openAttachModal(termId) {
  attachTargetTermId = termId;
  attachArmed = true;
  $('#attach-overlay').classList.remove('hidden');
  loadAttachList();
}

function closeAttachModal() {
  $('#attach-overlay').classList.add('hidden');
  attachArmed = false;
}

async function loadAttachList() {
  const list = $('#attach-list');
  list.innerHTML = '<div class="attach-loading">Scanning windows…</div>';
  const res = await window.termivin.externalList($('#attach-all').checked);
  if (!res.ok) {
    list.innerHTML = '';
    list.appendChild(el('div', 'attach-loading', 'Failed: ' + (res.error || 'unknown')));
    return;
  }
  const items = Array.isArray(res.result) ? res.result : (res.result ? [res.result] : []);
  // don't offer windows that are already attached
  const usedHwnds = new Set();
  for (const ws of S.getState().workspaces) {
    for (const t of ws.terminals) {
      if (t.external && TM.isAttached(t.id)) usedHwnds.add(t.external.hwnd);
    }
  }
  list.innerHTML = '';
  const free = items.filter((w) => !usedHwnds.has(w.hwnd));
  if (!free.length) {
    list.appendChild(el('div', 'attach-loading', 'No console windows found. Tick "Show all windows" to list everything.'));
    return;
  }
  for (const w of free) {
    const row = el('div', 'attach-row');
    row.appendChild(el('span', 'attach-proc', w.proc));
    row.appendChild(el('span', 'attach-title', w.title));
    row.appendChild(el('span', 'attach-pid', 'pid ' + w.pid));
    row.addEventListener('click', () => doAttach(w));
    list.appendChild(row);
  }
}

async function doAttach(w) {
  const ws = S.activeWorkspace();
  if (!ws) return;
  closeAttachModal();

  let meta;
  if (attachTargetTermId) {
    const found = S.findTerminal(attachTargetTermId);
    if (!found) return;
    meta = found.meta;
    meta.external = { hwnd: w.hwnd, pid: w.pid, title: w.title };
  } else {
    meta = S.addTerminal(ws.id, {
      name: (w.title || w.proc).slice(0, 28) || 'External',
      type: 'external',
      external: { hwnd: w.hwnd, pid: w.pid, title: w.title },
    });
  }
  ws.view = 'canvas';
  S.scheduleSave();
  renderAll();

  await new Promise((r) => requestAnimationFrame(r));
  const rt = TM.ensureRuntime(meta);
  const dpr = window.devicePixelRatio || 1;
  const r = rt.body.getBoundingClientRect();
  const res = await window.termivin.externalAttach({
    hwnd: w.hwnd,
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    w: Math.round(r.width * dpr),
    h: Math.round(r.height * dpr),
  });
  if (res.ok) {
    meta.external.origStyle = res.origStyle ?? null; // persisted for robust detach
    S.scheduleSave();
    TM.markAttached(meta.id, true);
    captureExternalCwd(meta);
  } else {
    alert('Could not attach window: ' + (res.error || 'unknown error'));
    if (!attachTargetTermId) {
      // brand-new entry that failed to attach — don't leave a dead card behind
      TM.disposeTerminal(meta.id);
      S.removeTerminal(meta.id);
    }
  }
  attachTargetTermId = null;
  renderAll();
  return res.ok ? meta.id : null;
}

// Best-effort: remember the external terminal's real working directory so a
// later "Convert to terminal" reopens in the right place.
async function captureExternalCwd(meta) {
  try {
    const res = await window.termivin.externalCwds(meta.external.pid);
    if (!res.ok) return;
    const cands = Array.isArray(res.result) ? res.result : (res.result ? [res.result] : []);
    if (!cands.length) return;
    meta.external.cwdCandidates = cands.map((c) => ({ name: c.name, cwd: c.cwd }));
    meta.cwd = cands[0].cwd;
    S.scheduleSave();
  } catch {}
}

// --- convert a (detached) external terminal into a managed terminal ----------

let convertTermId = null;

function setupConvertModal() {
  $('#cv-cancel').addEventListener('click', closeConvertModal);
  $('#convert-overlay').addEventListener('click', (e) => {
    if (e.target === $('#convert-overlay')) closeConvertModal();
  });
  $('#cv-browse').addEventListener('click', async () => {
    const dir = await window.termivin.pickFolder();
    if (dir) $('#cv-cwd').value = dir;
  });
  $('#cv-create').addEventListener('click', doConvert);
}

export async function openConvertModal(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  convertTermId = termId;
  const meta = found.meta;

  // Claude Code window titles start with "✳" — preselect accordingly
  const looksClaude = /✳|claude/i.test(meta.name) || /✳|claude/i.test(meta.external?.title || '');
  $('#cv-type').value = looksClaude ? 'claude' : 'shell';
  $('#cv-cwd').value = meta.cwd || window.termivin.homedir;
  $('#convert-overlay').classList.remove('hidden');

  // fill suggestions: captured shell cwds first, then recent Claude projects
  const dl = $('#cv-recent');
  dl.innerHTML = '';
  const seen = new Set();
  const addOpt = (v) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    const o = document.createElement('option');
    o.value = v;
    dl.appendChild(o);
  };
  for (const c of meta.external?.cwdCandidates || []) addOpt(c.cwd);
  try {
    for (const p of await window.termivin.claudeRecentProjects()) addOpt(p);
  } catch {}
}

function closeConvertModal() {
  $('#convert-overlay').classList.add('hidden');
  convertTermId = null;
}

async function doConvert() {
  const found = convertTermId ? S.findTerminal(convertTermId) : null;
  if (!found) return closeConvertModal();
  const meta = found.meta;
  const kind = $('#cv-type').value;
  const cwd = $('#cv-cwd').value.trim() || window.termivin.homedir;
  closeConvertModal();

  // If still attached, give the window back to the desktop first
  if (TM.isAttached(meta.id)) {
    await window.termivin.externalDetach({
      hwnd: meta.external.hwnd,
      origStyle: meta.external.origStyle ?? null,
    });
  }
  TM.disposeTerminal(meta.id); // drop the external pane/runtime, keep the meta

  meta.type = kind === 'claude' ? 'claude' : 'shell';
  meta.shell = null;
  meta.cwd = cwd;
  meta.command = kind === 'claude' ? 'claude --continue' : '';
  meta.restoreCommand = kind === 'claude' ? 'claude --continue' : '';
  meta.external = null;
  meta.autoRestore = true;
  S.scheduleSave();

  renderAll();
  await TM.spawnTerminal(meta, { useRestore: false });
  renderAll();
  TM.focusTerminal(meta.id);
}

// --- drop-to-attach: user dragged a window and released it over the canvas ---
// Attaches immediately; a short toast offers Undo in case of an accidental drop.

let dropToastTimer = null;
let dropBusy = false;

async function handleWindowDropped(info) {
  const ws = S.activeWorkspace();
  // Only react while armed by the "Attach window" button — one attach per click.
  if (!attachArmed || !ws || ws.view !== 'canvas' || dropBusy) return;
  // already attached somewhere? then ignore
  for (const w of S.getState().workspaces) {
    for (const t of w.terminals) {
      if (t.external && t.external.hwnd === info.hwnd && TM.isAttached(t.id)) return;
    }
  }
  // only when dropped over the canvas area
  const content = document.getElementById('content').getBoundingClientRect();
  if (info.x < content.left || info.x > content.right || info.y < content.top || info.y > content.bottom) return;

  dropBusy = true;
  try {
    // Re-use a detached entry for the same window instead of duplicating it,
    // unless the modal was opened from a specific entry (re-attach target).
    let target = attachTargetTermId;
    if (!target) {
      outer: for (const w of S.getState().workspaces) {
        for (const t of w.terminals) {
          if (t.external && t.external.hwnd === info.hwnd && !TM.isAttached(t.id)) {
            target = t.id;
            break outer;
          }
        }
      }
    }
    closeAttachModal(); // also disarms
    attachTargetTermId = target || null;
    const termId = await doAttach({ hwnd: info.hwnd, pid: info.pid, title: info.title, proc: '' });
    if (termId) showUndoToast(info, termId);
  } finally {
    dropBusy = false;
    attachArmed = false;
    attachTargetTermId = null;
  }
}

function showUndoToast(info, termId) {
  document.querySelectorAll('.drop-toast').forEach((t) => t.remove());
  clearTimeout(dropToastTimer);

  const toast = el('div', 'drop-toast');
  const label = el('div', 'drop-toast-label');
  label.append(el('span', 'drop-toast-icon', '⧉'));
  label.append(el('span', null, 'Attached "' + (info.title.length > 36 ? info.title.slice(0, 35) + '…' : info.title) + '"'));
  const btns = el('div', 'drop-toast-btns');
  const undo = el('button', 'btn btn-ghost btn-sm', '↩ Undo');
  btns.append(undo);
  toast.append(label, btns);

  // bottom-right corner: the embedded native window paints above the DOM,
  // so a toast at the drop point would be hidden behind it
  document.body.appendChild(toast);

  const dismiss = () => {
    toast.remove();
    clearTimeout(dropToastTimer);
  };
  undo.addEventListener('click', () => {
    dismiss();
    detachExternal(termId, { remove: true });
  });
  dropToastTimer = setTimeout(dismiss, 6000);
}

// ---------------------------------------------------------------- dashboard

export function renderDashboard() {
  const dash = $('#dashboard');
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard') return;
  dash.innerHTML = '';

  for (const t of ws.terminals) {
    dash.appendChild(buildCard(t));
  }
  updateDashboard();
}

function buildCard(t) {
  const info = typeInfo(t.external ? 'external' : t.type);
  const card = el('div', 'card');
  card.dataset.termId = t.id;

  const head = el('div', 'card-head');
  const icon = el('span', 'type-icon', info.icon);
  icon.style.color = info.color;
  const name = el('span', 'card-name', t.name);
  const pill = el('span', 'status-pill');
  head.append(icon, name, pill);

  const metaLine = t.external
    ? `${info.label} · ${t.external.title || ''} (pid ${t.external.pid || '?'})`
    : `${info.label} · ${shortPath(t.cwd)}`;
  const meta = el('div', 'card-meta', metaLine);

  const preview = el('pre', 'card-preview');

  const approvalBar = el('div', 'approval-bar hidden');
  const apHint = el('span', 'approval-hint');
  const apYes = el('button', 'btn btn-approve btn-sm', '✓ Approve');
  const apNo = el('button', 'btn btn-deny btn-sm', '✗ Deny');
  approvalBar.append(apHint, apYes, apNo);

  const actions = el('div', 'card-actions');

  card.append(head, meta, preview, approvalBar, actions);

  name.addEventListener('dblclick', () => {
    inlineRename(name, t.name, (val) => {
      if (val) S.renameTerminal(t.id, val);
      renderTabs();
      renderDashboard();
    });
  });

  apYes.addEventListener('click', () => TM.approve(t.id, true));
  apNo.addEventListener('click', () => TM.approve(t.id, false));

  buildCardActions(t, actions);
  return card;
}

function buildCardActions(t, actions) {
  actions.innerHTML = '';
  const st = TM.getStatus(t.id);
  const ws = S.activeWorkspace();

  const mkBtn = (label, cls, fn) => {
    const b = el('button', 'btn btn-sm ' + cls, label);
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };

  const openInCanvas = () => {
    if (!ws) return;
    ws.activeTerminalId = t.id;
    ws.view = 'canvas';
    S.bringToFront(t.id);
    S.scheduleSave();
    renderAll();
    TM.focusTerminal(t.id);
  };

  if (t.external) {
    if (st === 'attached') {
      mkBtn('⤢ Open', 'btn-ghost', openInCanvas);
      mkBtn('⇱ Detach', 'btn-ghost', () => {
        if (confirm(`Detach "${t.name}"? The window returns to the desktop.`)) {
          detachExternal(t.id, { remove: false });
        }
      });
    } else {
      mkBtn('⧉ Attach window…', 'btn-primary', () => openAttachModal(t.id));
      mkBtn('⇄ Convert…', 'btn-ghost', () => openConvertModal(t.id));
    }
    mkBtn('🗑 Remove', 'btn-ghost btn-danger-text', () => closeOrRemoveTerminal(t.id));
    return;
  }

  if (st === 'saved' || st === 'exited') {
    if (t.restoreCommand && (st === 'exited' || (t.savedTail && t.savedTail.length))) {
      mkBtn('↻ Resume', 'btn-primary', async () => {
        await TM.spawnTerminal(t, { useRestore: true });
        renderAll();
      });
      mkBtn('▶ Fresh start', 'btn-ghost', async () => {
        await TM.spawnTerminal(t, { useRestore: false });
        renderAll();
      });
    } else {
      mkBtn('▶ Start', 'btn-primary', async () => {
        await TM.spawnTerminal(t, { useRestore: false });
        renderAll();
      });
    }
    mkBtn('🗑 Remove', 'btn-ghost btn-danger-text', () => closeOrRemoveTerminal(t.id));
  } else {
    mkBtn('⤢ Open', 'btn-ghost', openInCanvas);
    mkBtn('⛶ Fullscreen', 'btn-ghost', () => toggleFullscreen(t.id));
    mkBtn('■ Stop', 'btn-ghost btn-danger-text', () => {
      if (!confirm(`Stop the process in "${t.name}"?`)) return;
      TM.stopTerminal(t.id);
      updateCardFull(t.id);
    });
  }
}

export function updateDashboard() {
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard') return;
  for (const t of ws.terminals) {
    const card = document.querySelector(`.card[data-term-id="${t.id}"]`);
    if (!card) continue;
    const st = TM.getStatus(t.id);
    const pill = card.querySelector('.status-pill');
    pill.textContent = STATUS_LABEL[st];
    pill.className = 'status-pill st-' + st;
    card.classList.toggle('card-approval', st === 'approval');

    const preview = card.querySelector('.card-preview');
    if (t.external) {
      preview.textContent = st === 'attached'
        ? '(external window — output not captured)'
        : '(external window — not attached)';
    } else {
      const lines = TM.getPreview(t.id, 12);
      const text = lines.length ? lines.join('\n') : '(no output yet)';
      if (preview.textContent !== text) {
        preview.textContent = text;
        preview.scrollTop = preview.scrollHeight;
      }
      preview.classList.toggle('preview-stale', st === 'saved');
    }

    const bar = card.querySelector('.approval-bar');
    const ap = TM.getApproval(t.id);
    bar.classList.toggle('hidden', !ap);
    if (ap) card.querySelector('.approval-hint').textContent = ap.hint;
  }
}

function updateCardFull(termId) {
  const card = document.querySelector(`.card[data-term-id="${termId}"]`);
  const found = S.findTerminal(termId);
  if (!card || !found) return;
  buildCardActions(found.meta, card.querySelector('.card-actions'));
  updateDashboard();
}

// ---------------------------------------------------------------- live

export function updateLive() {
  const ws = S.activeWorkspace();
  if (ws) {
    for (const t of ws.terminals) {
      const dot = document.querySelector(`.tab[data-term-id="${t.id}"] .dot`);
      if (dot) dot.className = 'dot st-' + TM.getStatus(t.id);
    }
  }
  renderSidebarBadges();
  updatePanes();
  updateDashboard();
}

export function onTerminalStatusChanged(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  renderSidebarBadges();
  const ws = S.activeWorkspace();
  if (ws && found.ws.id === ws.id) {
    const dot = document.querySelector(`.tab[data-term-id="${termId}"] .dot`);
    if (dot) dot.className = 'dot st-' + TM.getStatus(termId);
    updatePanes();
    updateCardFull(termId);
    renderHeader();
  }
}

// ---------------------------------------------------------------- modal

export function setupModal() {
  const overlay = $('#modal-overlay');
  const typeSel = $('#nt-type');

  typeSel.innerHTML = '';
  for (const [key, info] of Object.entries(TYPES)) {
    const opt = el('option', null, info.label);
    opt.value = key;
    typeSel.appendChild(opt);
  }

  const applyPreset = () => {
    const info = typeInfo(typeSel.value);
    $('#nt-command').value = info.command || '';
    $('#nt-restore').value = info.restoreCommand || '';
  };
  typeSel.addEventListener('change', applyPreset);

  $('#nt-browse').addEventListener('click', async () => {
    const dir = await window.termivin.pickFolder();
    if (dir) $('#nt-cwd').value = dir;
  });

  $('#nt-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  $('#nt-create').addEventListener('click', createFromModal);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') createFromModal();
  });

  const open = () => openModal();
  $('#new-terminal-btn').addEventListener('click', open);
  $('#empty-new-terminal').addEventListener('click', open);
}

export function openModal() {
  const ws = S.activeWorkspace();
  if (!ws) return;
  const overlay = $('#modal-overlay');
  overlay.classList.remove('hidden');
  const typeSel = $('#nt-type');
  typeSel.value = 'claude';
  const info = typeInfo('claude');
  const existingNames = ws.terminals.map((t) => t.name);
  $('#nt-name').value = '';
  $('#nt-name').placeholder = randomTerminalName(existingNames);
  $('#nt-command').value = info.command;
  $('#nt-restore').value = info.restoreCommand;
  const lastCwd = lastUsedCwd || window.termivin.homedir;
  $('#nt-cwd').value = lastCwd;
  $('#nt-autorestore').checked = true;
  $('#nt-name').focus();
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
}

let lastUsedCwd = null;

async function createFromModal() {
  const ws = S.activeWorkspace();
  if (!ws) return;
  const type = $('#nt-type').value;
  const info = typeInfo(type);
  const name = $('#nt-name').value.trim() || $('#nt-name').placeholder;
  const cwd = $('#nt-cwd').value.trim() || window.termivin.homedir;
  lastUsedCwd = cwd;

  const meta = S.addTerminal(ws.id, {
    name,
    type,
    shell: info.shell || null,
    cwd,
    command: $('#nt-command').value.trim(),
    restoreCommand: $('#nt-restore').value.trim(),
    autoRestore: $('#nt-autorestore').checked,
  });
  closeModal();
  ws.view = 'canvas';
  await TM.spawnTerminal(meta, { useRestore: false });
  renderAll();
  TM.focusTerminal(meta.id);
}

// ---------------------------------------------------------------- top-level

export function renderAll() {
  renderSidebar();
  renderHeader();
  renderTabs();
  renderContent();
}

export function setupChrome() {
  $('#new-workspace-btn').addEventListener('click', () => {
    const names = S.getState().workspaces.map((w) => w.name);
    S.addWorkspace(randomWorkspaceName(names));
    renderAll();
    const item = document.querySelector(`.ws-item[data-ws-id="${S.getState().activeWorkspaceId}"] .ws-name`);
    if (item) {
      inlineRename(item, item.textContent, (val) => {
        if (val) S.renameWorkspace(S.getState().activeWorkspaceId, val);
        renderAll();
      });
    }
  });

  for (const btn of document.querySelectorAll('#view-toggle .seg-btn')) {
    btn.addEventListener('click', () => {
      const ws = S.activeWorkspace();
      if (!ws) return;
      ws.view = btn.dataset.view;
      S.scheduleSave();
      renderAll();
    });
  }

  $('#ws-restore-btn').addEventListener('click', async () => {
    const ws = S.activeWorkspace();
    if (!ws) return;
    for (const t of ws.terminals) {
      if (!t.external && !TM.isRunning(t.id)) {
        await TM.spawnTerminal(t, { useRestore: true });
      }
    }
    renderAll();
  });

  window.addEventListener('resize', () => {
    TM.fitAllVisible();
    syncExternalRects();
  });

  const bar = $('#tabbar');
  bar.addEventListener('dragover', (e) => {
    if (dragTermId && e.target === bar) e.preventDefault();
  });
  bar.addEventListener('drop', (e) => {
    const ws = S.activeWorkspace();
    if (dragTermId && ws && e.target === bar) {
      e.preventDefault();
      S.moveTerminal(dragTermId, ws.id);
      renderAll();
    }
  });

  setupCanvasInteractions();
  setupAttachModal();
  setupConvertModal();

  if (isWin) {
    window.termivin.onExternalDropped((info) => handleWindowDropped(info));
  }
}
