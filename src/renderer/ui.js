// All DOM rendering & interactions: sidebar, tabs, floating canvas,
// dashboard, modals, drag&drop, external-window embedding.

import * as S from './state.js';
import * as TM from './term-manager.js';
import { TYPES, typeInfo, isAgentType, randomWorkspaceName, randomTerminalName } from './presets.js';
import { initDashData, onBusEvent } from './dash-data.js';
import {
  initWorkspaceDashboard, renderWorkspaceDashboard, refreshWorkspaceDashboard, pulseWorkspaceMap,
} from './dashboard.js';
import {
  initHome, renderHome, refreshHome, pulseHomeMap, isHome, updatePeek, closePeek,
} from './home.js';
import { THEMES, applyThemeToDom } from './themes.js';

const $ = (sel) => document.querySelector(sel);
const isWin = window.termivin.platform === 'win32';
const isMac = window.termivin.platform === 'darwin';

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

  // This input always lands inside chrome built for dragging, and both drag
  // mechanisms make it unusable: a pane bar calls preventDefault() on mousedown
  // (which kills the caret and starts moving the pane instead), and a tab is
  // draggable="true" (which swallows text selection). Neutralise both for as
  // long as the input is on screen.
  const dragParent = input.closest('[draggable="true"]');
  if (dragParent) dragParent.draggable = false;
  const swallow = (e) => e.stopPropagation();
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
    input.addEventListener(type, swallow);
  }

  input.focus();
  input.select();
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (dragParent) dragParent.draggable = true;
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

// ------------------------------------------------------------- dialogs
// Themed replacements for native confirm()/alert(): match the app's modal
// look, don't block the event loop, and hide embedded external windows while
// open (native windows always paint above the DOM).

let dialogEl = null;

function ensureDialogEl() {
  if (dialogEl) return dialogEl;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay dialog-overlay hidden';
  overlay.innerHTML = `
    <div class="modal dialog-box">
      <div class="modal-title dialog-title"></div>
      <div class="dialog-message"></div>
      <input type="text" class="dialog-input hidden" />
      <div class="modal-actions">
        <button class="btn btn-ghost dialog-cancel">Cancel</button>
        <button class="btn btn-primary dialog-ok">OK</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  dialogEl = overlay;
  return overlay;
}

function showDialog(message, { title = 'Termivin', okLabel = 'OK', cancelLabel = 'Cancel', danger = false, alertOnly = false, prompt = false, initial = '' } = {}) {
  const overlay = ensureDialogEl();
  const okBtn = overlay.querySelector('.dialog-ok');
  const cancelBtn = overlay.querySelector('.dialog-cancel');
  const input = overlay.querySelector('.dialog-input');
  overlay.querySelector('.dialog-title').textContent = title;
  overlay.querySelector('.dialog-message').textContent = message;
  okBtn.textContent = okLabel;
  okBtn.className = 'btn dialog-ok ' + (danger ? 'btn-danger' : 'btn-primary');
  cancelBtn.textContent = cancelLabel;
  cancelBtn.classList.toggle('hidden', alertOnly);
  input.classList.toggle('hidden', !prompt);
  input.value = prompt ? initial : '';
  overlay.classList.remove('hidden');
  syncExternalRects();

  return new Promise((resolve) => {
    const done = (val) => {
      overlay.classList.add('hidden');
      okBtn.onclick = cancelBtn.onclick = overlay.onclick = overlay.onkeydown = null;
      syncExternalRects();
      // prompt mode resolves with the typed string (or null on cancel)
      resolve(prompt ? (val ? input.value.trim() : null) : val);
    };
    okBtn.onclick = () => done(true);
    cancelBtn.onclick = () => done(false);
    overlay.onclick = (e) => {
      if (e.target === overlay) done(false);
    };
    overlay.onkeydown = (e) => {
      if (e.key === 'Escape') done(false);
      if (e.key === 'Enter') done(true);
    };
    if (prompt) {
      input.focus();
      input.select();
    } else {
      okBtn.focus();
    }
  });
}

export const uiConfirm = (message, opts = {}) => showDialog(message, opts);
export const uiAlert = (message, opts = {}) => showDialog(message, { ...opts, alertOnly: true });
export const uiPrompt = (message, opts = {}) => showDialog(message, { ...opts, prompt: true });

async function closeOrRemoveTerminal(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  const t = found.meta;
  if (t.external) {
    const yes = await uiConfirm(
      `Detach "${t.name}" (the window returns to the desktop) and remove it from the workspace?`,
      { title: 'Remove external window', okLabel: 'Detach & remove', danger: true });
    if (!yes) return;
    detachExternal(termId, { remove: true });
    return;
  }
  const running = TM.isRunning(termId);
  const msg = running
    ? `Close terminal "${t.name}"? The running process will be stopped and the terminal removed from the workspace.`
    : `Remove terminal "${t.name}" from the workspace?`;
  const yes = await uiConfirm(msg, {
    title: running ? 'Close terminal' : 'Remove terminal',
    okLabel: running ? 'Close' : 'Remove',
    danger: true,
  });
  if (!yes) return;
  TM.disposeTerminal(termId);
  S.removeTerminal(termId);
  renderAll();
}

// Clone a terminal: open the new-terminal dialog prefilled with the source's
// cwd, commands and settings so the user can tweak before creating. The name
// placeholder is a fresh pool name that doesn't collide with the source.
// ------------------------------------------------------------- agent bus

// Push the live roster (who exists, in which workspace, and what state they
// are in) to the bus. It is the bus's only source of truth for peer lookup,
// so this must run on every render and status change.
export function syncBusRoster() {
  const state = S.getState();
  if (!state) return;
  const list = [];
  for (const ws of state.workspaces) {
    for (const t of ws.terminals) {
      if (t.external) continue; // external windows have no shell to run the CLI
      list.push({
        termId: t.id,
        spaceId: ws.id,
        spaceName: ws.name,
        name: t.name,
        type: t.type,
        status: TM.getStatus(t.id),
      });
    }
  }
  window.termivin.busRoster(list);
}

// The prompt the 🔗 button types into an agent. It carries the workspace name
// and current peers so the agent knows who it is joining, and tells it to poll
// at task boundaries — agents have no event loop and will otherwise never
// check for mail.
//
// Deliberately ONE line: a newline is a submit in every terminal, so a
// multi-line prompt gets chopped into fragments — and in a shell it drops into
// a continuation prompt and eats the rest.
function connectPrompt(ws, self, peers) {
  const others = peers.length
    ? peers.map((p) => `${p.name} (${p.type})`).join(', ')
    : 'none yet, you are the first';
  return [
    `You are agent "${self.name}" in the Termivin workspace "${ws.name}",`,
    'which has a local message bus the agents here use to talk to each other.',
    `Peers right now: ${others}.`,
    'Join it by running: termivin register --role "<one line: what you are working on and which files you own>".',
    'Then: `termivin who` lists your teammates;',
    '`termivin send <name> "..."` messages one agent (use @all to broadcast, add --ask for a question);',
    '`termivin recv --wait 60` blocks up to 60s waiting for messages;',
    '`termivin topics` lists cross-workspace topics — message one with: termivin send "#topic" "...".',
    'Run `termivin recv` whenever you finish a task or are about to wait on something —',
    'nothing pushes messages into your session, so unread mail sits there until you look.',
    'Do not reply to broadcasts unless the message asks you to.',
  ].join(' ');
}

async function connectAgent(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  const { ws, meta } = found;

  const status = TM.getStatus(termId);
  if (status === 'approval') {
    // Enter means "yes" at a permission prompt (see approvalKeys); typing here
    // would approve whatever is being asked.
    await uiAlert(
      `"${meta.name}" is waiting for your approval. Answer that prompt first — ` +
      'typing now would submit an answer to it.',
      { title: 'Cannot connect yet' }
    );
    return;
  }
  if (status !== 'idle' && status !== 'working') {
    await uiAlert(
      `"${meta.name}" is not running (${STATUS_LABEL[status] || status}). Start it first.`,
      { title: 'Cannot connect yet' }
    );
    return;
  }

  // Plain shells sit on the bus too (handy for inspecting it by hand), but
  // they are not agents — don't introduce them as teammates.
  const peers = ws.terminals.filter((t) => t.id !== termId && !t.external && isAgentType(t.type));
  const ok = await uiConfirm(
    `Type the bus connection prompt into "${meta.name}"?\n\n` +
    `It will be asked to register itself in workspace "${ws.name}"` +
    (peers.length ? ` alongside ${peers.length} other agent(s).` : ' as the first agent.'),
    { title: 'Connect to agent bus', okLabel: 'Type it' }
  );
  if (!ok) return;

  // Send the prompt as one paste-like write, then Enter separately so a CLI
  // that reflows multi-line input has a frame to settle.
  TM.sendKeys(termId, connectPrompt(ws, meta, peers));
  setTimeout(() => TM.sendKeys(termId, '\r'), 120);
  TM.focusTerminal(termId);
}

// --------------------------------------------------- pane "more" menu (⋯)
// The pane bar has no room left, and these actions are occasional rather than
// per-second, so they live behind one button instead of five.

let paneMenuTermId = null;
let paneMenuOutside = null;

function closePaneMenu() {
  document.querySelectorAll('.pane-menu').forEach((m) => m.remove());
  paneMenuTermId = null;
  if (paneMenuOutside) {
    window.removeEventListener('mousedown', paneMenuOutside, true);
    paneMenuOutside = null;
  }
}

function startPaneRename(termId) {
  const rt = TM.getRuntime(termId);
  const found = S.findTerminal(termId);
  if (!rt || !found) return;
  const nameEl = rt.pane.querySelector('.pane-name');
  if (!nameEl) return;
  inlineRename(nameEl, found.meta.name, (val) => {
    if (val) S.renameTerminal(termId, val);
    renderTabs();
    renderDashboard();
    updatePanes();
  });
}

async function revealFolder(dir) {
  const res = await window.termivin.openFolder(dir);
  if (!res.ok) await uiAlert(res.error, { title: 'Could not open folder' });
}

async function openInEditor(dir) {
  const res = await window.termivin.openInEditor(dir);
  if (!res.ok) await uiAlert(res.error, { title: 'Could not open VS Code' });
}

function openPaneMenu(termId, anchor) {
  const reopening = paneMenuTermId === termId;
  closePaneMenu();
  if (reopening) return; // the ⋯ button toggles
  const found = S.findTerminal(termId);
  if (!found) return;
  const { meta } = found;

  const menu = el('div', 'pane-menu');
  const add = (label, fn) => {
    const item = el('button', 'pane-menu-item', label);
    item.addEventListener('click', () => {
      closePaneMenu();
      fn();
    });
    menu.appendChild(item);
  };

  add('✎   Rename…', () => startPaneRename(termId));
  if (!meta.external) {
    add('↻   Refresh view', () => TM.refreshTerminal(termId));
    add('🧹  Clear scrollback', () => TM.clearScrollback(termId));
    if (TM.isRunning(termId)) {
      add('■   Stop process', async () => {
        if (await uiConfirm(`Stop the process in "${meta.name}"? The terminal stays in the workspace.`,
            { title: 'Stop process', okLabel: 'Stop', danger: true })) {
          TM.stopTerminal(termId);
          renderAll();
        }
      });
    }
  }
  menu.appendChild(el('div', 'pane-menu-sep'));
  const cwd = meta.cwd || window.termivin.homedir;
  add('📁  Open folder', () => revealFolder(cwd));
  add('⌨   Open in VS Code', () => openInEditor(cwd));

  document.body.appendChild(menu);
  paneMenuTermId = termId;

  // Right-align under the button, but never off-screen.
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = Math.max(6, Math.min(r.right - w, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 6) + 'px';

  // Ignore mousedowns on a ⋯ button so the toggle above gets its turn.
  paneMenuOutside = (e) => {
    if (menu.contains(e.target) || e.target.closest('.pane-more')) return;
    closePaneMenu();
  };
  window.addEventListener('mousedown', paneMenuOutside, true);
}

function cloneTerminal(termId) {
  const found = S.findTerminal(termId);
  if (!found || found.meta.external || found.meta.type === 'external') return;
  const src = found.meta;
  openModal({
    type: src.type,
    cwd: src.cwd,
    command: src.command,
    restoreCommand: src.restoreCommand,
    autoRestore: src.autoRestore,
  });
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
  $('#home-item').classList.toggle('active', isHome());

  for (const ws of state.workspaces) {
    const item = el('div', 'ws-item' + (!isHome() && ws.id === state.activeWorkspaceId ? ' active' : ''));
    item.dataset.wsId = ws.id;
    item.draggable = true;

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
      item.draggable = false; // draggable parents break text selection in the input
      inlineRename(name, ws.name, (val) => {
        if (val) S.renameWorkspace(ws.id, val);
        renderSidebar();
        renderHeader();
      });
    };

    item.addEventListener('click', (e) => {
      if (e.target === del || e.target === ren) return;
      const wasHome = isHome();
      if (!wasHome && ws.id === S.getState().activeWorkspaceId) return; // keep DOM stable so dblclick-rename works
      S.getState().appView = 'ws';
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

    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const n = ws.terminals.length;
      const msg = n
        ? `Delete workspace "${ws.name}" and its ${n} terminal(s)? Running processes will be stopped.`
        : `Delete workspace "${ws.name}"?`;
      if (!(await uiConfirm(msg, { title: 'Delete workspace', okLabel: 'Delete', danger: true }))) return;
      const orphans = S.removeWorkspace(ws.id);
      for (const t of orphans) TM.disposeTerminal(t.id);
      // topics anchored to this workspace have no home anymore — drop them
      try {
        const stats = await window.termivin.busStats();
        for (const t of stats.topics.filter((t) => t.spaceId === ws.id)) {
          await window.termivin.busTopicDelete(t.id);
        }
      } catch {}
      renderAll();
    });

    // Drag source for workspace reordering
    item.addEventListener('dragstart', (e) => {
      dragWsId = ws.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      dragWsId = null;
      clearWsDropMarkers();
    });

    // Drop target: terminal tabs move into this workspace; other workspace
    // items reorder around it (top/bottom half = insert before/after).
    item.addEventListener('dragover', (e) => {
      if (dragTermId) {
        e.preventDefault();
        item.classList.add('drop-target');
      } else if (dragWsId && dragWsId !== ws.id) {
        e.preventDefault();
        const r = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        item.classList.toggle('ws-drop-before', before);
        item.classList.toggle('ws-drop-after', !before);
      }
    });
    item.addEventListener('dragleave', () =>
      item.classList.remove('drop-target', 'ws-drop-before', 'ws-drop-after'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drop-target', 'ws-drop-before', 'ws-drop-after');
      if (dragTermId) {
        S.moveTerminal(dragTermId, ws.id);
        renderAll();
      } else if (dragWsId && dragWsId !== ws.id) {
        const r = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        const list = S.getState().workspaces;
        const targetIdx = list.findIndex((w) => w.id === ws.id);
        const beforeId = before ? ws.id : (list[targetIdx + 1] ? list[targetIdx + 1].id : null);
        S.moveWorkspace(dragWsId, beforeId);
        dragWsId = null;
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
  const home = isHome();
  const ws = S.activeWorkspace();
  $('#ws-title').textContent = home ? 'Overview' : ws ? ws.name : '';
  $('#view-toggle').classList.toggle('hidden', home);
  $('#new-terminal-btn').classList.toggle('hidden', home);

  for (const btn of document.querySelectorAll('#view-toggle .seg-btn')) {
    btn.classList.toggle('active', !home && ws && btn.dataset.view === ws.view);
  }

  const anySaved = !home && ws && ws.terminals.some((t) => !t.external && !TM.isRunning(t.id));
  $('#ws-restore-btn').classList.toggle('hidden', !ws || !anySaved);
  const anyOpen = !home && ws && ws.terminals.filter((t) => !t.minimized).length > 1;
  $('#arrange-btn').classList.toggle('hidden', !anyOpen);
  const attachBtn = $('#attach-window-btn');
  attachBtn.classList.toggle('hidden', home || !(isWin || isMac));
  if (isMac) attachBtn.textContent = '⧉ Adopt terminal';
}

// Tile all open (non-minimized) terminals of the active workspace into a
// grid that fills the canvas, leaving the dock strip clear when present.
function arrangeTerminals() {
  const ws = S.activeWorkspace();
  if (!ws) return;
  ws.view = 'canvas';
  ws.fullscreenTerminalId = null;
  const items = ws.terminals.filter((t) => !t.minimized);
  if (!items.length) return;

  const host = $('#content').getBoundingClientRect();
  const MARGIN = 10;
  const GAP = 10;
  const dockW = ws.terminals.some((t) => t.minimized) ? 220 : 0;
  const availW = Math.max(320, host.width - dockW - MARGIN * 2);
  const availH = Math.max(180, host.height - MARGIN * 2);
  const n = items.length;

  // Pick the column count whose cells come closest to a 16:10 aspect ratio.
  let cols = Math.ceil(Math.sqrt(n));
  let bestScore = -Infinity;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const cw = (availW - GAP * (c - 1)) / c;
    const ch = (availH - GAP * (r - 1)) / r;
    const score = -Math.abs(Math.log((cw / ch) / 1.6));
    if (score > bestScore) {
      bestScore = score;
      cols = c;
    }
  }
  const rows = Math.ceil(n / cols);
  const w = Math.max(320, Math.floor((availW - GAP * (cols - 1)) / cols));
  const h = Math.max(180, Math.floor((availH - GAP * (rows - 1)) / rows));

  items.forEach((t, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    t.layout.x = MARGIN + c * (w + GAP);
    t.layout.y = MARGIN + r * (h + GAP);
    t.layout.w = w;
    t.layout.h = h;
  });
  S.scheduleSave();
  renderContent();
}

let dragWsId = null;

function clearWsDropMarkers() {
  document.querySelectorAll('.ws-item').forEach((i) =>
    i.classList.remove('ws-drop-before', 'ws-drop-after'));
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
    const tab = el('div', 'tab' + (t.id === ws.activeTerminalId ? ' active' : '') + (t.minimized ? ' minimized' : ''));
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
      if (t.minimized) {
        restoreMinimized(t.id);
        return;
      }
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

  if (isHome()) {
    dash.classList.add('hidden');
    tabwrap.classList.add('hidden');
    empty.classList.add('hidden');
    hideAllPanes();
    renderHome();
    renderDock();
    syncExternalRects();
    return;
  }
  $('#home').classList.add('hidden');

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
    renderDock();
    syncExternalRects();
    return;
  }

  empty.classList.add('hidden');
  tabwrap.classList.remove('hidden');

  if (ws.view === 'dashboard') {
    dash.classList.remove('hidden');
    hideAllPanes();
    renderDashboard();
    renderDock();
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
    if (pane.classList.contains('peeked')) continue; // owned by the peek overlay
    if (fsId) {
      pane.classList.toggle('fullscreen', t.id === fsId);
      pane.classList.toggle('hidden', t.id !== fsId);
    } else {
      pane.classList.remove('fullscreen');
      pane.classList.toggle('hidden', !!t.minimized);
      applyLayout(pane, t.layout);
    }
    pane.classList.toggle('focused', t.id === ws.activeTerminalId);
    const maxBtn = pane.querySelector('.pane-max');
    maxBtn.textContent = t.id === fsId ? '🗗' : '⛶';
    maxBtn.title = t.id === fsId ? 'Exit fullscreen' : 'Fullscreen';
  }

  // hide panes belonging to other workspaces (a peeked pane stays visible —
  // it lives in the peek overlay, not on the canvas)
  document.querySelectorAll('#panes .pane').forEach((pane) => {
    if (!activeIds.has(pane.dataset.termId) && !pane.classList.contains('peeked')) {
      pane.classList.add('hidden');
    }
  });

  updatePanes();
  renderDock();
  TM.fitAllVisible();
  syncExternalRects();
}

function hideAllPanes() {
  document.querySelectorAll('#panes .pane').forEach((p) => {
    if (!p.classList.contains('peeked')) p.classList.add('hidden');
  });
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
  const found = S.findTerminal(termId);
  if (found && found.meta.minimized) found.meta.minimized = false;
  ws.fullscreenTerminalId = ws.fullscreenTerminalId === termId ? null : termId;
  ws.activeTerminalId = termId;
  ws.view = 'canvas';
  S.scheduleSave();
  renderAll();
  TM.focusTerminal(termId);
}

// --------------------------------------------------------------- dock
// Minimize rarely-watched terminals (dev servers, watchers…) into a compact
// chip stack on the right edge of the canvas. They keep running — the chip
// shows live status and pulses on approval prompts. Click a chip to restore.

function minimizeTerminal(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  found.meta.minimized = true;
  if (found.ws.fullscreenTerminalId === termId) found.ws.fullscreenTerminalId = null;
  S.scheduleSave();
  renderContent();
  renderTabs();
}

function restoreMinimized(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  found.meta.minimized = false;
  found.ws.activeTerminalId = termId;
  S.bringToFront(termId);
  S.scheduleSave();
  renderContent();
  renderTabs();
  TM.focusTerminal(termId);
}

function buildDockChip(t) {
  const info = typeInfo(t.external ? 'external' : t.type);
  const st = TM.getStatus(t.id);
  const chip = el('div', 'dock-chip' + (st === 'approval' ? ' needs-approval' : ''));
  chip.dataset.termId = t.id;
  chip.title = `${t.name} — click to restore, right-click to group`;
  const head = el('div', 'dock-head');
  const dot = el('span', 'dot st-' + st);
  const icon = el('span', 'dock-icon', info.icon);
  icon.style.color = info.color;
  const name = el('span', 'dock-name', t.name);
  head.append(dot, icon, name);
  const preview = el('div', 'dock-preview');
  setDockPreview(preview, t);
  chip.append(head, preview);
  chip.addEventListener('click', () => restoreMinimized(t.id));
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openDockChipMenu(t.id, e.clientX, e.clientY);
  });
  return chip;
}

// The status a group header shows: the most urgent status among its members.
const DOCK_ST_RANK = { approval: 5, working: 4, idle: 3, attached: 3, exited: 2, saved: 1 };

function renderDock() {
  const dock = $('#dock');
  const ws = S.activeWorkspace();
  // The dock belongs to the workspace canvas — never over Home or a dashboard.
  const docked =
    !isHome() && ws && ws.view === 'canvas' && !ws.fullscreenTerminalId
      ? ws.terminals.filter((t) => t.minimized)
      : [];
  dock.classList.toggle('hidden', !docked.length);
  dock.innerHTML = '';
  if (!docked.length) return;

  // Grouped chips fold into one dropdown per group; ungrouped chips stay flat.
  const groups = new Map(); // name -> terminals
  const loose = [];
  for (const t of docked) {
    if (t.dockGroup) {
      if (!groups.has(t.dockGroup)) groups.set(t.dockGroup, []);
      groups.get(t.dockGroup).push(t);
    } else {
      loose.push(t);
    }
  }

  for (const [gname, terms] of groups) {
    const collapsed = !!ws.dockCollapsed[gname];
    const box = el('div', 'dock-group' + (collapsed ? ' collapsed' : ''));
    const head = el('div', 'dock-group-head');
    const chev = el('span', 'dock-group-chev', collapsed ? '›' : '⌄');
    const label = el('span', 'dock-group-name', gname);
    const worst = terms.reduce(
      (a, t) => (DOCK_ST_RANK[TM.getStatus(t.id)] > DOCK_ST_RANK[a] ? TM.getStatus(t.id) : a),
      'saved');
    const dot = el('span', 'dot st-' + worst);
    const count = el('span', 'dock-group-count', String(terms.length));
    head.append(chev, dot, label, count);
    head.title = collapsed ? 'Expand group' : 'Collapse group';
    head.addEventListener('click', () => {
      ws.dockCollapsed[gname] = !collapsed;
      S.scheduleSave();
      renderDock();
    });
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openDockGroupMenu(gname, e.clientX, e.clientY);
    });
    box.appendChild(head);
    if (!collapsed) {
      const body = el('div', 'dock-group-body');
      for (const t of terms) body.appendChild(buildDockChip(t));
      box.appendChild(body);
    }
    dock.appendChild(box);
  }

  for (const t of loose) dock.appendChild(buildDockChip(t));
}

// Right-click menu on a dock chip: assign it to a group (or leave one).
function openDockChipMenu(termId, x, y) {
  closePaneMenu();
  const ws = S.activeWorkspace();
  const found = S.findTerminal(termId);
  if (!ws || !found) return;
  const meta = found.meta;

  const menu = el('div', 'pane-menu');
  const add = (label, fn, cls = '') => {
    const item = el('button', 'pane-menu-item' + (cls ? ' ' + cls : ''), label);
    item.addEventListener('click', () => {
      closePaneMenu();
      fn();
    });
    menu.appendChild(item);
  };

  const groupNames = [...new Set(ws.terminals.filter((t) => t.dockGroup).map((t) => t.dockGroup))];
  for (const g of groupNames) {
    if (g === meta.dockGroup) continue;
    add(`📁  Move to "${g}"`, () => {
      meta.dockGroup = g;
      S.scheduleSave();
      renderDock();
    });
  }
  add('📁+  New group…', async () => {
    const name = await uiPrompt('Name for the new dock group:', {
      title: 'New group', okLabel: 'Create', initial: '',
    });
    if (!name) return;
    meta.dockGroup = name;
    delete ws.dockCollapsed[name]; // a brand-new group starts expanded
    S.scheduleSave();
    renderDock();
  });
  if (meta.dockGroup) {
    add('⏏   Remove from group', () => {
      meta.dockGroup = null;
      S.scheduleSave();
      renderDock();
    });
  }
  menu.appendChild(el('div', 'pane-menu-sep'));
  add('⊞   Restore', () => restoreMinimized(termId));

  placeFloatingMenu(menu, x, y);
}

// Right-click menu on a group header: rename or dissolve the group.
function openDockGroupMenu(gname, x, y) {
  closePaneMenu();
  const ws = S.activeWorkspace();
  if (!ws) return;
  const members = () => ws.terminals.filter((t) => t.dockGroup === gname);

  const menu = el('div', 'pane-menu');
  const add = (label, fn) => {
    const item = el('button', 'pane-menu-item', label);
    item.addEventListener('click', () => {
      closePaneMenu();
      fn();
    });
    menu.appendChild(item);
  };
  add('✎   Rename group…', async () => {
    const name = await uiPrompt('New name for this group:', {
      title: 'Rename group', okLabel: 'Rename', initial: gname,
    });
    if (!name || name === gname) return;
    for (const t of members()) t.dockGroup = name;
    if (ws.dockCollapsed[gname]) {
      ws.dockCollapsed[name] = true;
      delete ws.dockCollapsed[gname];
    }
    S.scheduleSave();
    renderDock();
  });
  add('⊞   Restore all', () => {
    for (const t of members()) t.minimized = false;
    S.scheduleSave();
    renderContent();
    renderTabs();
  });
  add('⏏   Ungroup', () => {
    for (const t of members()) t.dockGroup = null;
    delete ws.dockCollapsed[gname];
    S.scheduleSave();
    renderDock();
  });
  placeFloatingMenu(menu, x, y);
}

// Shared positioning + outside-click dismissal for context menus opened at a
// screen point (the ⋯ pane menu positions against its anchor instead).
function placeFloatingMenu(menu, x, y) {
  document.body.appendChild(menu);
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - menu.offsetWidth - 6)) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 6) + 'px';
  paneMenuOutside = (e) => {
    if (menu.contains(e.target)) return;
    closePaneMenu();
  };
  window.addEventListener('mousedown', paneMenuOutside, true);
}

function setDockPreview(previewEl, t) {
  if (t.external) {
    previewEl.textContent = '(external window)';
    return;
  }
  const lines = TM.getPreview(t.id, 6);
  const text = lines.length ? lines.join('\n') : '(no output yet)';
  if (previewEl.textContent !== text) {
    previewEl.textContent = text;
    previewEl.scrollTop = previewEl.scrollHeight;
  }
}

// Refresh chip status dots + previews without rebuilding the dock
function updateDock() {
  document.querySelectorAll('#dock .dock-chip').forEach((chip) => {
    const termId = chip.dataset.termId;
    const st = TM.getStatus(termId);
    chip.querySelector('.dot').className = 'dot st-' + st;
    chip.classList.toggle('needs-approval', st === 'approval');
    const found = S.findTerminal(termId);
    const previewEl = chip.querySelector('.dock-preview');
    if (found && previewEl) setDockPreview(previewEl, found.meta);
  });
  // group headers: most urgent member status
  const ws = S.activeWorkspace();
  if (!ws) return;
  document.querySelectorAll('#dock .dock-group').forEach((box) => {
    const gname = box.querySelector('.dock-group-name')?.textContent;
    if (!gname) return;
    const worst = ws.terminals
      .filter((t) => t.minimized && t.dockGroup === gname)
      .reduce((a, t) => (DOCK_ST_RANK[TM.getStatus(t.id)] > DOCK_ST_RANK[a] ? TM.getStatus(t.id) : a), 'saved');
    const dot = box.querySelector('.dock-group-head .dot');
    if (dot) dot.className = 'dot st-' + worst;
  });
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

    // Resize from any edge/corner via the .pane-rs handles.
    const handle = e.target.closest('.pane-rs');
    if (handle && !ws.fullscreenTerminalId && found) {
      drag = {
        mode: handle.dataset.dir,
        meta: found.meta,
        pane,
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...found.meta.layout },
      };
      document.body.style.cursor = getComputedStyle(handle).cursor;
      document.body.classList.add('dragging-pane');
      e.preventDefault();
      return;
    }

    const bar = e.target.closest('.pane-bar');
    if (bar && !ws.fullscreenTerminalId && found) {
      drag = {
        mode: 'move',
        meta: found.meta,
        pane,
        startX: e.clientX,
        startY: e.clientY,
        orig: { ...found.meta.layout },
      };
      // Embedded native windows paint above ALL DOM (sidebar, dialogs), so
      // hide them for the duration of the drag — the pane frame remains as
      // the drag feedback. Re-shown on mouseup by syncExternalRects.
      if (found.meta.external && TM.isAttached(termId)) {
        hiddenWhileDragId = termId;
        window.termivin.externalShow({ hwnd: found.meta.external.hwnd, visible: false });
      }
      document.body.classList.add('dragging-pane');
      e.preventDefault();
    }
  });

  const MIN_W = 320;
  const MIN_H = 180;

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const host = $('#content').getBoundingClientRect();
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const o = drag.orig;
    const L = drag.meta.layout;

    if (drag.mode === 'move') {
      // External panes may never overhang the canvas — the native window
      // inside cannot be clipped by the DOM and would cover the sidebar.
      const minX = drag.meta.external ? 0 : -o.w + 120;
      L.x = Math.max(minX, Math.min(o.x + dx, host.width - 60));
      L.y = Math.max(0, Math.min(o.y + dy, host.height - 40));
      // Dragging over the sidebar: highlight the workspace under the cursor
      // as a move target (drop there → confirm dialog → move the terminal).
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const item = under && under.closest('.ws-item');
      const targetId =
        item && item.dataset.wsId !== S.getState().activeWorkspaceId ? item.dataset.wsId : null;
      if (targetId !== drag.dropWsId) {
        drag.dropWsId = targetId;
        document.querySelectorAll('.ws-item.drop-target').forEach((i) => i.classList.remove('drop-target'));
        if (targetId) item.classList.add('drop-target');
      }
    } else {
      // Resize: east/south grow the box; west/north also shift the origin so
      // the opposite edge stays put — like resizing a real OS window.
      if (drag.mode.includes('e')) L.w = Math.max(MIN_W, o.w + dx);
      if (drag.mode.includes('s')) L.h = Math.max(MIN_H, o.h + dy);
      if (drag.mode.includes('w')) {
        const overhang = drag.meta.external ? 0 : 60; // externals can't overhang (native window)
        L.w = Math.max(MIN_W, Math.min(o.w - dx, o.x + o.w + overhang));
        L.x = o.x + (o.w - L.w);
      }
      if (drag.mode.includes('n')) {
        L.h = Math.max(MIN_H, Math.min(o.h - dy, o.y + o.h));
        L.y = o.y + (o.h - L.h);
      }
      drag.pane.style.width = L.w + 'px';
      drag.pane.style.height = L.h + 'px';
    }
    drag.pane.style.left = L.x + 'px';
    drag.pane.style.top = L.y + 'px';
    throttledSyncExternal();
  });

  window.addEventListener('mouseup', async () => {
    hiddenWhileDragId = null;
    if (drag) {
      const d = drag;
      drag = null;
      document.body.classList.remove('dragging-pane');
      document.body.style.cursor = '';

      // Dropped on a sidebar workspace → confirm, then move the terminal.
      if (d.mode === 'move' && d.dropWsId) {
        document.querySelectorAll('.ws-item.drop-target').forEach((i) => i.classList.remove('drop-target'));
        // snap the pane back — this drag targeted the sidebar, not a new spot
        d.meta.layout.x = d.orig.x;
        d.meta.layout.y = d.orig.y;
        applyLayout(d.pane, d.meta.layout);
        syncExternalRects();
        const target = S.getWorkspace(d.dropWsId);
        if (target) {
          const yes = await uiConfirm(
            `Move terminal "${d.meta.name}" to workspace "${target.name}"?`,
            { title: 'Move terminal', okLabel: 'Move' });
          if (yes) {
            S.moveTerminal(d.meta.id, target.id);
            renderAll();
            return;
          }
        }
        S.scheduleSave();
        syncExternalRects();
        return;
      }
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
    else if (e.target.closest('.pane-min')) minimizeTerminal(termId);
    else if (e.target.closest('.pane-connect')) connectAgent(termId);
    else if (e.target.closest('.pane-more')) openPaneMenu(termId, e.target.closest('.pane-more'));
    else if (e.target.closest('.pane-clone')) cloneTerminal(termId);
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

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.pane-menu')) closePaneMenu();
  });
}

function renderTabsActiveOnly(ws) {
  document.querySelectorAll('#tabbar .tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.termId === ws.activeTerminalId);
  });
}

// ---------------------------------------------------------------- external

// External window temporarily hidden while its pane is being dragged
// (native windows can't be clipped and would cover the sidebar/dialogs).
let hiddenWhileDragId = null;

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
  // Embedded native windows always paint above the DOM, so hide them while
  // any modal/dialog is open — otherwise they'd cover it.
  const modalUp = !!document.querySelector('.modal-overlay:not(.hidden)');

  for (const ws of state.workspaces) {
    for (const t of ws.terminals) {
      if (!t.external || !TM.isAttached(t.id)) continue;
      const rt = TM.getRuntime(t.id);
      const visible =
        !modalUp &&
        t.id !== hiddenWhileDragId &&
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
  const overlay = $('#attach-overlay');
  if (!isWin) {
    overlay.querySelector('.modal-title').textContent = 'Adopt terminal session';
    overlay.querySelector('.attach-note').textContent =
      'Pick a running terminal below to re-open it inside Termivin at its current folder. Press Esc to cancel.';
  }
  overlay.classList.remove('hidden');
  syncExternalRects();
  loadAttachList();
}

function closeAttachModal() {
  $('#attach-overlay').classList.add('hidden');
  attachArmed = false;
  syncExternalRects();
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
    list.appendChild(el('div', 'attach-loading', isWin
      ? 'No console windows found. Tick "Show all windows" to list everything.'
      : 'No terminal sessions found. Tick "Show all" to list every process on a tty.'));
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

// macOS can't embed windows, so "adopting" a terminal means re-opening it as a
// managed terminal in the same folder (agents resume their last session).
async function adoptMacTerminal(w) {
  const ws = S.activeWorkspace();
  if (!ws) return null;
  closeAttachModal();
  const kind = w.kind === 'claude' || w.kind === 'codex' ? w.kind : 'shell';
  const info = typeInfo(kind);
  const name = kind === 'shell'
    ? ((w.cwd && w.cwd.split('/').filter(Boolean).pop()) || 'Shell')
    : info.label;
  const meta = S.addTerminal(ws.id, {
    name: String(name).slice(0, 28) || 'Terminal',
    type: kind,
    cwd: w.cwd || undefined,
    command: info.command,
    restoreCommand: info.restoreCommand,
    autoRestore: true,
  });
  ws.view = 'canvas';
  S.scheduleSave();
  renderAll();
  await new Promise((r) => requestAnimationFrame(r));
  await TM.spawnTerminal(meta, { useRestore: true });
  renderAll();
  TM.focusTerminal(meta.id);
  attachTargetTermId = null;
  return meta.id;
}

async function doAttach(w) {
  if (!isWin) return adoptMacTerminal(w);
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
    await uiAlert('Could not attach window: ' + (res.error || 'unknown error'), { title: 'Attach failed' });
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
    // Start the picker at whatever is already typed, not the OS default.
    const dir = await window.termivin.pickFolder($('#cv-cwd').value.trim());
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
  syncExternalRects();

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
  syncExternalRects();
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
// The workspace dashboard itself lives in dashboard.js (bus map + management
// panel); these delegators keep the old call sites working.

export function renderDashboard() {
  const ws = S.activeWorkspace();
  if (!ws || ws.view !== 'dashboard') return;
  renderWorkspaceDashboard();
}

export function updateDashboard() {
  refreshWorkspaceDashboard();
}


// ---------------------------------------------------------------- live

export function updateLive() {
  const ws = S.activeWorkspace();
  if (ws && !isHome()) {
    for (const t of ws.terminals) {
      const dot = document.querySelector(`.tab[data-term-id="${t.id}"] .dot`);
      if (dot) dot.className = 'dot st-' + TM.getStatus(t.id);
    }
  }
  renderSidebarBadges();
  updatePanes();
  updateDock();
  updateDashboard();
  refreshHome();
  updatePeek();
}

export function onTerminalStatusChanged(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  syncBusRoster();
  renderSidebarBadges();
  const ws = S.activeWorkspace();
  if (ws && found.ws.id === ws.id) {
    const dot = document.querySelector(`.tab[data-term-id="${termId}"] .dot`);
    if (dot) dot.className = 'dot st-' + TM.getStatus(termId);
    updatePanes();
    updateDashboard();
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
    // Start the picker at whatever is already typed (a cloned terminal
    // prefills its source folder), not wherever Explorer last was.
    const dir = await window.termivin.pickFolder($('#nt-cwd').value.trim());
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

// prefill: clone flow — seed the fields from an existing terminal instead of
// the type preset, and let the user adjust before creating.
export function openModal(prefill = null) {
  const ws = S.activeWorkspace();
  if (!ws) return;
  const overlay = $('#modal-overlay');
  overlay.classList.remove('hidden');
  syncExternalRects();
  const typeSel = $('#nt-type');
  const type = (prefill && prefill.type) || 'claude';
  typeSel.value = typeSel.querySelector(`option[value="${type}"]`) ? type : 'custom';
  const info = typeInfo(type);
  const existingNames = ws.terminals.map((t) => t.name);
  $('#nt-name').value = '';
  $('#nt-name').placeholder = randomTerminalName(existingNames);
  $('#nt-command').value = prefill ? prefill.command || '' : info.command;
  $('#nt-restore').value = prefill ? prefill.restoreCommand || '' : info.restoreCommand;
  $('#nt-cwd').value = (prefill && prefill.cwd) || lastUsedCwd || window.termivin.homedir;
  $('#nt-autorestore').checked = prefill ? prefill.autoRestore !== false : true;
  $('#nt-name').focus();
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  syncExternalRects();
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
  syncBusRoster();
}

// ------------------------------------------------------------- settings
// One setting so far: the app theme. Applied instantly on click — DOM via
// data-theme, live terminals via TM.applyXtermTheme — and persisted.

export function applyTheme(name) {
  const state = S.getState();
  state.theme = THEMES[name] ? name : 'termivin';
  applyThemeToDom(state.theme);
  TM.applyXtermTheme(state.theme);
  S.scheduleSave();
  renderThemeList();
}

function renderThemeList() {
  const list = $('#theme-list');
  if (!list) return;
  const current = S.getState().theme || 'termivin';
  list.innerHTML = '';
  for (const [key, t] of Object.entries(THEMES)) {
    const card = el('button', 'theme-card' + (key === current ? ' active' : ''));
    card.dataset.theme = key;
    const swatches = el('span', 'theme-swatches');
    for (const c of t.swatches) {
      const s = el('span', 'theme-swatch');
      s.style.background = c;
      swatches.appendChild(s);
    }
    const meta = el('span', 'theme-meta');
    meta.append(el('span', 'theme-name', t.label), el('span', 'theme-desc', t.desc));
    card.append(swatches, meta);
    card.addEventListener('click', () => applyTheme(key));
    list.appendChild(card);
  }
}

function setupSettings() {
  const overlay = $('#settings-overlay');
  $('#settings-btn').addEventListener('click', () => {
    renderThemeList();
    overlay.classList.remove('hidden');
    syncExternalRects();
  });
  const close = () => {
    overlay.classList.add('hidden');
    syncExternalRects();
  };
  $('#settings-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
  });
}

// Jump to a workspace from anywhere (home map, dashboard, peek header).
export function switchWorkspace(wsId) {
  closePeek();
  const state = S.getState();
  state.appView = 'ws';
  S.setActiveWorkspace(wsId);
  renderAll();
  autoRestoreWorkspace(wsId);
}

// Open one terminal on its workspace's canvas, focused.
export function openInCanvas(termId) {
  const found = S.findTerminal(termId);
  if (!found) return;
  S.getState().appView = 'ws';
  S.setActiveWorkspace(found.ws.id);
  found.ws.view = 'canvas';
  found.ws.activeTerminalId = termId;
  if (found.meta.minimized) found.meta.minimized = false;
  S.bringToFront(termId);
  S.scheduleSave();
  renderAll();
  TM.focusTerminal(termId);
}

export function setupChrome() {
  initDashData();
  const uiHooks = {
    openInCanvas,
    switchWorkspace,
    renderAll,
    uiPrompt,
    uiConfirm,
    uiAlert,
  };
  initWorkspaceDashboard(uiHooks);
  initHome(uiHooks);
  onBusEvent((evt) => {
    pulseWorkspaceMap(evt);
    pulseHomeMap(evt);
  });

  $('#home-item').addEventListener('click', () => {
    S.getState().appView = 'home';
    S.scheduleSave();
    renderAll();
  });

  $('#new-workspace-btn').addEventListener('click', () => {
    const names = S.getState().workspaces.map((w) => w.name);
    S.getState().appView = 'ws';
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

  $('#arrange-btn').addEventListener('click', arrangeTerminals);

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
  setupSettings();

  if (isWin) {
    window.termivin.onExternalDropped((info) => handleWindowDropped(info));
  }
}
