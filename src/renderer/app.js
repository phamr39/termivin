// Entry point: load state, wire everything, run periodic refresh & autosave.

import * as S from './state.js';
import * as TM from './term-manager.js';
import * as UI from './ui.js';

async function main() {
  await S.loadState();

  // Debug/testing hook (harmless in production)
  window.__termivin = { S, TM };

  TM.initPtyEvents();
  TM.onStatusChange((termId) => UI.onTerminalStatusChanged(termId));

  UI.setupModal();
  UI.setupChrome();
  UI.renderAll();

  await readoptEmbeddedWindows();
  await migrateLostExternals();
  // No click needed: the open workspace restores itself; others restore on
  // first visit (see autoRestoreWorkspace in ui.js).
  await UI.autoRestoreWorkspace(S.getState().activeWorkspaceId);

  // Live status refresh (tab dots, badges, dashboard previews)
  setInterval(() => UI.updateLive(), 1500);

  // Detect externally-attached windows being closed by the user
  setInterval(() => UI.checkExternalAlive(), 5000);

  // Periodically snapshot terminal output so a crash/quit keeps recent context
  setInterval(() => TM.saveAllTails(), 15000);

  // Final synchronous save on close
  window.addEventListener('beforeunload', () => {
    TM.saveAllTails();
    S.saveNowSync();
  });
}

// After a renderer reload (Ctrl+R), external windows may still be physically
// embedded in our window — re-adopt them instead of showing "not attached".
async function readoptEmbeddedWindows() {
  if (window.termivin.platform !== 'win32') return;
  let changed = false;
  for (const ws of S.getState().workspaces) {
    for (const t of ws.terminals) {
      if (t.external && t.external.hwnd != null && !TM.isAttached(t.id)) {
        try {
          if (await window.termivin.externalIsAttached(t.external.hwnd)) {
            TM.ensureRuntime(t);
            TM.markAttached(t.id, true);
            changed = true;
          }
        } catch {}
      }
    }
  }
  if (changed) {
    UI.renderAll();
    UI.syncExternalRects();
  }
}

// External windows that are no longer embedded (app was closed) can't come
// back as-is — recreate them automatically as managed terminals at their last
// known working directory: Claude sessions get "claude --continue", anything
// else gets a plain shell.
async function migrateLostExternals() {
  if (window.termivin.platform !== 'win32') return;
  const toSpawn = [];
  for (const ws of S.getState().workspaces) {
    for (const t of ws.terminals) {
      if (!t.external || TM.isAttached(t.id)) continue;
      const looksClaude = /✳|claude/i.test(t.name) || /✳|claude/i.test(t.external.title || '');
      TM.disposeTerminal(t.id); // drop the external-flavored pane, keep the meta
      t.type = looksClaude ? 'claude' : 'shell';
      t.shell = null;
      t.command = looksClaude ? 'claude --continue' : '';
      t.restoreCommand = looksClaude ? 'claude --continue' : '';
      t.external = null;
      t.autoRestore = true;
      toSpawn.push(t);
    }
  }
  if (!toSpawn.length) return;
  // Converted entries are now in the "saved" state — the per-workspace
  // auto-restore spawns them when their workspace is opened.
  S.scheduleSave();
  UI.renderAll();
}


main();
