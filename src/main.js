const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyLoadError = String(err && err.message ? err.message : err);
}

let win = null;
const ptys = new Map(); // termId -> IPty

function stateFile() {
  return path.join(app.getPath('userData'), 'termivin-state.json');
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    const file = stateFile();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('Failed to save state:', err);
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#101418',
    title: 'Termivin',
    icon: path.join(__dirname, '..', 'assets',
      process.platform === 'win32' ? 'icon.ico' : 'termivin-logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      console.log(`[renderer:${e.level}] ${e.message}`);
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
  // Start the Win32 helper eagerly so the drop-to-attach hook is live
  ensureEmbedHelper();
}

// ---------- PTY IPC ----------

ipcMain.handle('pty:create', (event, opts) => {
  if (!pty) return { ok: false, error: 'node-pty is not available: ' + ptyLoadError };
  const { id, shell, args = [], cwd, command, cols = 80, rows = 24 } = opts;

  // If a pty with this id is still alive, kill it first
  const existing = ptys.get(id);
  if (existing) {
    try { existing.kill(); } catch {}
    ptys.delete(id);
  }

  let proc;
  try {
    proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath('home'),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  ptys.set(id, proc);

  proc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', id, exitCode);
  });

  if (command && command.trim()) {
    // Give the shell a moment to boot before typing the startup command.
    setTimeout(() => {
      const p = ptys.get(id);
      if (p === proc) {
        try { proc.write(command.trim() + '\r'); } catch {}
      }
    }, 600);
  }

  return { ok: true, pid: proc.pid };
});

ipcMain.on('pty:write', (event, id, data) => {
  const p = ptys.get(id);
  if (p) {
    try { p.write(data); } catch {}
  }
});

ipcMain.on('pty:resize', (event, id, cols, rows) => {
  const p = ptys.get(id);
  if (p && cols > 0 && rows > 0) {
    try { p.resize(cols, rows); } catch {}
  }
});

ipcMain.on('pty:kill', (event, id) => {
  const p = ptys.get(id);
  if (p) {
    try { p.kill(); } catch {}
    ptys.delete(id);
  }
});

// ---------- State persistence ----------

ipcMain.handle('state:load', () => readState());
ipcMain.handle('state:save', (event, state) => writeState(state));
ipcMain.on('state:save-sync', (event, state) => {
  event.returnValue = writeState(state);
});

// ---------- External window embedding (Windows only) ----------

let embedProc = null;
let embedBuf = '';
let embedSeq = 0;
const embedPending = new Map(); // id -> {resolve}
const attachedHwnds = new Set(); // windows currently embedded in our window

function ensureEmbedHelper() {
  if (process.platform !== 'win32') return null;
  if (embedProc && !embedProc.killed) return embedProc;
  embedProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'win-embed.ps1'),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  embedProc.stdout.on('data', (chunk) => {
    embedBuf += chunk.toString('utf8');
    let idx;
    while ((idx = embedBuf.indexOf('\n')) !== -1) {
      const line = embedBuf.slice(0, idx).trim();
      embedBuf = embedBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.evt) {
          handleHelperEvent(msg);
          continue;
        }
        const pending = embedPending.get(msg.id);
        if (pending) {
          embedPending.delete(msg.id);
          pending.resolve(msg);
        }
      } catch {}
    }
  });
  embedProc.stderr.on('data', (d) => console.error('[win-embed]', d.toString().trim()));
  embedProc.on('exit', () => {
    embedProc = null;
    for (const p of embedPending.values()) p.resolve({ ok: false, error: 'helper exited' });
    embedPending.clear();
  });
  return embedProc;
}

function embedCall(cmd, params = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const proc = ensureEmbedHelper();
    if (!proc) return resolve({ ok: false, error: 'not supported on this platform' });
    const id = ++embedSeq;
    embedPending.set(id, { resolve });
    setTimeout(() => {
      if (embedPending.has(id)) {
        embedPending.delete(id);
        resolve({ ok: false, error: 'helper timeout' });
      }
    }, timeoutMs);
    try {
      proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
    } catch (err) {
      embedPending.delete(id);
      resolve({ ok: false, error: String(err) });
    }
  });
}

// A window was dropped (finished moving) somewhere on screen. If the cursor
// is inside our content area, offer the renderer a drop-to-attach.
function handleHelperEvent(msg) {
  if (msg.evt !== 'movesizeend') return;
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
  if (msg.pid === process.pid) return;
  const cur = screen.getCursorScreenPoint();
  const cb = win.getContentBounds();
  if (cur.x < cb.x || cur.y < cb.y || cur.x >= cb.x + cb.width || cur.y >= cb.y + cb.height) return;
  let title = '';
  try { title = Buffer.from(msg.title_b64 || '', 'base64').toString('utf8'); } catch {}
  win.webContents.send('external:dropped', {
    hwnd: msg.hwnd,
    pid: msg.pid,
    title,
    x: cur.x - cb.x,
    y: cur.y - cb.y,
  });
}

function parentHwnd() {
  if (!win || win.isDestroyed()) return 0;
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

ipcMain.handle('external:list', async (event, all) => {
  return embedCall('list', { all: !!all, excludePid: process.pid });
});

ipcMain.handle('external:attach', async (event, opts) => {
  const res = await embedCall('attach', {
    hwnd: opts.hwnd, parent: parentHwnd(),
    x: opts.x | 0, y: opts.y | 0, w: opts.w | 0, h: opts.h | 0,
  });
  if (res.ok) attachedHwnds.add(opts.hwnd);
  return res;
});

// Is this window still physically embedded in us? (survives renderer reloads)
ipcMain.handle('external:is-attached', async (event, hwnd) => {
  const res = await embedCall('parent', { hwnd });
  const ours = !!(res.ok && Number(res.result) === parentHwnd());
  if (ours) attachedHwnds.add(hwnd);
  return ours;
});

ipcMain.on('external:move', (event, opts) => {
  embedCall('move', { hwnd: opts.hwnd, x: opts.x | 0, y: opts.y | 0, w: opts.w | 0, h: opts.h | 0 });
});

ipcMain.on('external:show', (event, opts) => {
  embedCall('show', { hwnd: opts.hwnd, visible: !!opts.visible });
});

ipcMain.handle('external:alive', async (event, hwnd) => {
  const res = await embedCall('alive', { hwnd });
  return !!(res.ok && res.result);
});

ipcMain.handle('external:detach', async (event, opts) => {
  const hwnd = typeof opts === 'object' ? opts.hwnd : opts;
  const origStyle = typeof opts === 'object' ? opts.origStyle : null;
  const res = await embedCall('detach', { hwnd, origStyle });
  attachedHwnds.delete(hwnd);
  return res;
});

ipcMain.handle('external:close', async (event, hwnd) => {
  return embedCall('closeWindow', { hwnd });
});

ipcMain.handle('external:cwds', async (event, pid) => {
  return embedCall('cwds', { pid }, 15000);
});

// Recent Claude Code project directories (from ~/.claude/projects transcripts)
// — used as suggestions when converting an external terminal to a Claude one.
ipcMain.handle('claude:recent-projects', () => {
  try {
    const base = path.join(os.homedir(), '.claude', 'projects');
    const byCwd = new Map(); // cwd -> mtime
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(base, d.name);
      try {
        const jsonls = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (!jsonls.length) continue;
        const newest = path.join(dir, jsonls[0].f);
        const fd = fs.openSync(newest, 'r');
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 20)) {
          try {
            const obj = JSON.parse(line);
            if (obj && typeof obj.cwd === 'string' && obj.cwd) {
              const prev = byCwd.get(obj.cwd) || 0;
              if (jsonls[0].m > prev) byCwd.set(obj.cwd, jsonls[0].m);
              break;
            }
          } catch {}
        }
      } catch {}
    }
    return [...byCwd.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([cwd]) => cwd);
  } catch {
    return [];
  }
});

// ---------- Dialogs ----------

ipcMain.handle('dialog:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- App lifecycle ----------

// Windows groups taskbar buttons (and picks their icon) by AppUserModelID —
// without this, dev runs show the generic Electron icon on the taskbar.
app.setAppUserModelId('com.termivin.app');

// One instance only: running `termivin` again focuses the existing window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  app.quit();
});

let detachDone = false;
app.on('before-quit', (event) => {
  for (const p of ptys.values()) {
    try { p.kill(); } catch {}
  }
  ptys.clear();

  // Give embedded external windows back to the desktop before we die —
  // destroying their parent window would destroy them too. Original window
  // styles come from the persisted state (survives helper restarts).
  if (!detachDone && attachedHwnds.size > 0 && embedProc) {
    event.preventDefault();
    const styles = new Map();
    const state = readState();
    if (state && Array.isArray(state.workspaces)) {
      for (const ws of state.workspaces) {
        for (const t of ws.terminals || []) {
          if (t.external && t.external.hwnd != null) {
            styles.set(t.external.hwnd, t.external.origStyle ?? null);
          }
        }
      }
    }
    const finish = () => {
      detachDone = true;
      try { embedProc.kill(); } catch {}
      app.quit();
    };
    const jobs = [...attachedHwnds].map((h) =>
      embedCall('detach', { hwnd: h, origStyle: styles.get(h) ?? null }, 2500)
    );
    Promise.race([
      Promise.all(jobs),
      new Promise((r) => setTimeout(r, 3000)),
    ]).then(finish, finish);
    return;
  }
  if (embedProc) {
    try { embedProc.kill(); } catch {}
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
