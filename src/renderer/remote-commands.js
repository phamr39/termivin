// Commands from the phone that change the workspace model. The renderer owns
// that model (state.js + the live panes), so main forwards these here and
// waits for the result. Kept free of confirm dialogs: the phone asks its own
// questions before sending.

import * as S from './state.js';
import * as TM from './term-manager.js';
import { TYPES, typeInfo, randomTerminalName, withPermissionMode, supportsPermissionMode } from './presets.js';
import { renderAll } from './ui.js';

function need(termId) {
  const found = S.findTerminal(termId);
  if (!found) throw new Error('no such terminal');
  if (found.meta.external) throw new Error('external windows cannot be controlled remotely');
  return found;
}

const handlers = {
  async 'term.restore'({ termId }) {
    const { meta } = need(termId);
    if (TM.isRunning(termId)) return { running: true };
    await TM.spawnTerminal(meta, { useRestore: !!(meta.restoreCommand) });
    renderAll();
    return { running: TM.isRunning(termId) };
  },

  async 'term.stop'({ termId }) {
    need(termId);
    TM.stopTerminal(termId);
    renderAll();
    return {};
  },

  async 'term.restart'({ termId }) {
    need(termId);
    const res = await TM.restartTerminal(termId);
    renderAll();
    if (res && res.ok === false) throw new Error(res.error || 'restart failed');
    return { command: TM.restartCommand(S.findTerminal(termId).meta) };
  },

  async 'term.rename'({ termId, name }) {
    need(termId);
    const clean = String(name || '').trim().slice(0, 28);
    if (!clean) throw new Error('name is empty');
    S.renameTerminal(termId, clean);
    renderAll();
    return { name: clean };
  },

  // Change a Claude Code terminal's permission mode. It takes effect on the
  // next (re)start; pass restart: true to apply it right away.
  async 'term.mode'({ termId, mode, restart }) {
    const { meta } = need(termId);
    if (!supportsPermissionMode(meta.type)) throw new Error('only Claude Code terminals have a permission mode');
    const m = ['', 'auto', 'acceptEdits', 'plan'].includes(mode || '') ? (mode || '') : null;
    if (m === null) throw new Error('unknown mode');
    meta.command = withPermissionMode(meta.command || typeInfo(meta.type).command, m);
    meta.restoreCommand = withPermissionMode(meta.restoreCommand || typeInfo(meta.type).restoreCommand, m);
    S.scheduleSave();
    if (restart && TM.isRunning(termId)) await TM.restartTerminal(termId);
    renderAll();
    return { command: meta.command, restoreCommand: meta.restoreCommand };
  },

  async 'term.create'({ spaceId, type = 'claude', name, cwd, mode }) {
    const ws = S.getWorkspace(spaceId) || S.activeWorkspace();
    if (!ws) throw new Error('no such workspace');
    if (!TYPES[type] || type === 'custom') throw new Error('unsupported terminal type');
    const info = typeInfo(type);
    const names = S.getState().workspaces.flatMap((w) => w.terminals.map((t) => t.name));
    let command = info.command || '';
    let restoreCommand = info.restoreCommand || '';
    if (supportsPermissionMode(type) && mode) {
      command = withPermissionMode(command, mode);
      restoreCommand = withPermissionMode(restoreCommand, mode);
    }
    const meta = S.addTerminal(ws.id, {
      name: String(name || '').trim().slice(0, 28) || randomTerminalName(names),
      type,
      shell: info.shell || null,
      cwd: cwd || undefined,
      command,
      restoreCommand,
      autoRestore: true,
    });
    renderAll();
    await new Promise((r) => requestAnimationFrame(r));
    await TM.spawnTerminal(meta, { useRestore: false });
    renderAll();
    return { termId: meta.id, name: meta.name };
  },
};

export function initRemoteCommands() {
  if (!window.termivin.onRemoteCmd) return;
  window.termivin.onRemoteCmd(async ({ id, op, args }) => {
    const fn = handlers[op];
    try {
      if (!fn) throw new Error('unknown_op');
      const data = await fn(args || {});
      window.termivin.remoteCmdResult({ id, ok: true, data });
    } catch (err) {
      window.termivin.remoteCmdResult({ id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
}
