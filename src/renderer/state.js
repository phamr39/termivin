// App state: workspaces + terminal metadata. Persisted via main process.

let state = null;
let saveTimer = null;

export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function getState() {
  return state;
}

export async function loadState() {
  const loaded = await window.termivin.loadState();
  if (loaded && Array.isArray(loaded.workspaces) && loaded.workspaces.length) {
    state = loaded;
  } else {
    state = {
      version: 1,
      activeWorkspaceId: null,
      workspaces: [],
    };
    addWorkspace('Workspace 1');
  }
  if (!state.workspaces.find((w) => w.id === state.activeWorkspaceId)) {
    state.activeWorkspaceId = state.workspaces[0].id;
  }
  for (const ws of state.workspaces) {
    if (!ws.view || ws.view === 'terminals') ws.view = 'canvas';
    if (!('fullscreenTerminalId' in ws)) ws.fullscreenTerminalId = null;
    if (!Array.isArray(ws.terminals)) ws.terminals = [];
    ws.terminals.forEach((t, i) => {
      if (!t.layout) t.layout = defaultLayout(i);
      if (!('minimized' in t)) t.minimized = false;
      // external panes must stay fully inside the canvas (their embedded
      // native window cannot be clipped by the DOM)
      if (t.external) {
        t.layout.x = Math.max(0, t.layout.x);
        t.layout.y = Math.max(0, t.layout.y);
      }
    });
  }
  // Continue the z-order counter above anything persisted, so new/raised
  // panes always land on top of restored ones.
  for (const ws of state.workspaces) {
    for (const t of ws.terminals) {
      if (t.layout && t.layout.z >= zCounter) zCounter = t.layout.z + 1;
    }
  }
  return state;
}

let zCounter = 10;

export function defaultLayout(index) {
  const step = index % 8;
  return { x: 36 + step * 40, y: 28 + step * 34, w: 640, h: 420, z: ++zCounter };
}

export function bringToFront(termId) {
  const t = findTerminal(termId);
  if (t) {
    t.meta.layout.z = ++zCounter;
    scheduleSave();
  }
}

export function topZ(ws) {
  return Math.max(0, ...ws.terminals.map((t) => (t.layout ? t.layout.z : 0)));
}

export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.termivin.saveState(state);
  }, 400);
}

export function saveNowSync() {
  clearTimeout(saveTimer);
  try {
    window.termivin.saveStateSync(state);
  } catch {}
}

// --- Workspaces -----------------------------------------------------------

export function addWorkspace(name) {
  const ws = { id: uid('ws'), name, view: 'canvas', activeTerminalId: null, fullscreenTerminalId: null, terminals: [] };
  state.workspaces.push(ws);
  state.activeWorkspaceId = ws.id;
  scheduleSave();
  return ws;
}

export function removeWorkspace(wsId) {
  const idx = state.workspaces.findIndex((w) => w.id === wsId);
  if (idx === -1) return [];
  const [ws] = state.workspaces.splice(idx, 1);
  if (!state.workspaces.length) addWorkspace('Workspace 1');
  if (state.activeWorkspaceId === wsId) {
    state.activeWorkspaceId = state.workspaces[Math.max(0, idx - 1)].id;
  }
  scheduleSave();
  return ws.terminals; // caller must dispose of runtimes
}

export function renameWorkspace(wsId, name) {
  const ws = getWorkspace(wsId);
  if (ws && name.trim()) {
    ws.name = name.trim();
    scheduleSave();
  }
}

// Reorder workspaces (sidebar drag & drop). beforeWsId: insert position, or
// null to move to the end.
export function moveWorkspace(wsId, beforeWsId = null) {
  if (wsId === beforeWsId) return false;
  const idx = state.workspaces.findIndex((w) => w.id === wsId);
  if (idx === -1) return false;
  const [ws] = state.workspaces.splice(idx, 1);
  let insertIdx = state.workspaces.length;
  if (beforeWsId) {
    const i = state.workspaces.findIndex((w) => w.id === beforeWsId);
    if (i !== -1) insertIdx = i;
  }
  state.workspaces.splice(insertIdx, 0, ws);
  scheduleSave();
  return true;
}

export function getWorkspace(wsId) {
  return state.workspaces.find((w) => w.id === wsId) || null;
}

export function activeWorkspace() {
  return getWorkspace(state.activeWorkspaceId);
}

export function setActiveWorkspace(wsId) {
  if (getWorkspace(wsId)) {
    state.activeWorkspaceId = wsId;
    scheduleSave();
  }
}

// --- Terminals ------------------------------------------------------------

export function addTerminal(wsId, meta) {
  const ws = getWorkspace(wsId);
  if (!ws) return null;
  const term = {
    id: uid('t'),
    name: meta.name,
    type: meta.type,
    shell: meta.shell || null,
    cwd: meta.cwd || window.termivin.homedir,
    command: meta.command || '',
    restoreCommand: meta.restoreCommand || '',
    autoRestore: meta.autoRestore !== false,
    minimized: false,
    savedTail: [],
    layout: defaultLayout(ws.terminals.length),
    external: meta.external || null, // { pid, hwnd, title } for attached OS windows
    createdAt: Date.now(),
  };
  ws.terminals.push(term);
  ws.activeTerminalId = term.id;
  scheduleSave();
  return term;
}

export function removeTerminal(termId) {
  for (const ws of state.workspaces) {
    const idx = ws.terminals.findIndex((t) => t.id === termId);
    if (idx !== -1) {
      ws.terminals.splice(idx, 1);
      if (ws.activeTerminalId === termId) {
        const next = ws.terminals[Math.min(idx, ws.terminals.length - 1)];
        ws.activeTerminalId = next ? next.id : null;
      }
      if (ws.fullscreenTerminalId === termId) ws.fullscreenTerminalId = null;
      scheduleSave();
      return ws;
    }
  }
  return null;
}

export function renameTerminal(termId, name) {
  const t = findTerminal(termId);
  if (t && name.trim()) {
    t.meta.name = name.trim();
    scheduleSave();
  }
}

export function findTerminal(termId) {
  for (const ws of state.workspaces) {
    const meta = ws.terminals.find((t) => t.id === termId);
    if (meta) return { ws, meta };
  }
  return null;
}

// Move a terminal to another workspace (drag & drop). beforeTermId: insert
// position within the target workspace, or null to append.
export function moveTerminal(termId, targetWsId, beforeTermId = null) {
  const found = findTerminal(termId);
  const target = getWorkspace(targetWsId);
  if (!found || !target) return false;
  const { ws: source, meta } = found;

  const srcIdx = source.terminals.indexOf(meta);
  source.terminals.splice(srcIdx, 1);

  let insertIdx = target.terminals.length;
  if (beforeTermId) {
    const i = target.terminals.findIndex((t) => t.id === beforeTermId);
    if (i !== -1) insertIdx = i;
  }
  target.terminals.splice(insertIdx, 0, meta);

  if (source !== target && source.activeTerminalId === termId) {
    source.activeTerminalId = source.terminals[0] ? source.terminals[0].id : null;
  }
  if (source !== target) target.activeTerminalId = termId;
  scheduleSave();
  return true;
}
