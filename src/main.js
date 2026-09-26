const { app, BrowserWindow, ipcMain, dialog, screen, nativeImage, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const { pathToFileURL } = require('url');

// node-pty's macOS/Linux `spawn-helper` prebuilt binary loses its executable
// bit when the package is unpacked from an npm tarball. node-pty execs that
// helper to launch shells, so without +x every pty.spawn dies with
// "posix_spawnp failed" — terminals never start. Windows uses conpty and has
// no such helper, which is why this only bites on macOS/Linux. Restore the bit
// before requiring node-pty so the fix applies on a clean install too.
function ensurePtyHelperExecutable() {
  if (process.platform === 'win32') return;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(root, 'build', 'Release', 'spawn-helper'),
    ];
    for (const helper of candidates) {
      if (!fs.existsSync(helper)) continue;
      if ((fs.statSync(helper).mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
      }
    }
  } catch {}
}

let pty = null;
let ptyLoadError = null;
try {
  ensurePtyHelperExecutable();
  pty = require('node-pty');
} catch (err) {
  ptyLoadError = String(err && err.message ? err.message : err);
}

const bus = require('./agent-bus');
const procStats = require('./proc-stats');
const tokenUsage = require('./token-usage');
const { Hub } = require('./hub');
const { createRemote, rendererBridge } = require('./remote');
const { projectSlug } = require('./remote/transcripts');
const QRCode = require('qrcode');

let win = null;
const ptys = new Map(); // termId -> IPty
// Main's own view of every PTY (screen, status, approvals) — feeds the remote.
const hub = new Hub();
let remote = null;

function stateFile() {
  return path.join(app.getPath('userData'), 'termivin-state.json');
}

// A missing file means "first run"; an unreadable one must never be treated
// the same way — the renderer would start empty and the next save would
// overwrite the user's workspaces. Fall back to the backup, and keep the
// broken file aside so it can still be recovered by hand.
function readState() {
  const file = stateFile();
  if (!fs.existsSync(file)) return readJson(file + '.bak');
  const state = readJson(file);
  if (state) return state;
  try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
  console.error('State file unreadable, falling back to the backup');
  return readJson(file + '.bak');
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let lastBackupAt = 0;

// Write-to-temp + fsync + rename, so a crash leaves either the old or the new
// file. On Windows an antivirus or indexer briefly holding the target makes
// rename fail with EPERM/EBUSY — retry, then fall back to a plain copy.
function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      if (attempt >= 4) {
        fs.copyFileSync(tmp, file);
        try { fs.unlinkSync(tmp); } catch {}
        return;
      }
      sleepSync(25 * (attempt + 1));
    }
  }
}

function writeState(state) {
  try {
    const file = stateFile();
    // Saves are debounced but frequent; a backup a minute is plenty.
    if (Date.now() - lastBackupAt > 60000 && readJson(file)) {
      fs.copyFileSync(file, file + '.bak');
      lastBackupAt = Date.now();
    }
    writeJsonAtomic(file, state);
    if (remote) remote.setState(state);
    return true;
  } catch (err) {
    console.error('Failed to save state:', err);
    return false;
  }
}

// macOS ignores BrowserWindow's `icon`; the Dock icon comes from the app
// bundle, so a dev/`npx electron .` run shows the generic Electron icon. Set it
// explicitly at runtime so Termivin's logo appears on the Dock either way.
function setMacDockIcon() {
  if (process.platform !== 'darwin' || !app.dock) return;
  try {
    const img = nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'termivin-logo.png'));
    if (!img.isEmpty()) app.dock.setIcon(img);
    // The About panel otherwise reports the bundle's version, which unpackaged
    // is Electron's rather than ours (src/mac-app-name.js covers the name).
    app.setAboutPanelOptions({
      applicationName: 'Termivin',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2026 phamr39',
    });
  } catch {}
}

// macOS always shows a menu bar, and the native menu claims its accelerators
// before the renderer ever sees the keystroke — the inverse of Windows, which
// the terminal's own Ctrl+C/Ctrl+V handling relies on. Electron's stock menu
// therefore breaks two things here: Cmd+C copies the (always empty) DOM
// selection rather than xterm's canvas selection, and Cmd+W closes the only
// window, which quits the app and kills every pty. Ship a lean menu instead.
function setMacApplicationMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        // Shown but not registered, so the key reaches xterm's handler, which
        // copies a selection and otherwise still sends SIGINT. Chromium keeps
        // handling Cmd+C natively inside text inputs.
        { role: 'copy', accelerator: 'Cmd+C', registerAccelerator: false },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
    // Deliberately no Close item: one stray Cmd+W would take the session down.
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ]));
}

function createWindow() {
  setMacDockIcon();
  setMacApplicationMenu();
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
  if (process.platform === 'win32') {
    // The taskbar resolves an AUMID's icon through window app-details and the
    // installed shortcut carrying the same AUMID. Without both, dev/CLI runs
    // fall back to the generic electron.exe icon.
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
    const appRoot = path.join(__dirname, '..');
    try {
      win.setAppDetails({
        appId: 'com.termivin.app',
        appIconPath: iconPath,
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}" "${appRoot}"`,
        relaunchDisplayName: 'Termivin',
      });
    } catch {}
    ensureStartMenuShortcut(iconPath, appRoot);
  }
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') {
      console.log(`[renderer:${e.level}] ${e.message}`);
    }
  });
  // The window only ever shows our own page. Anything else — a link clicked in
  // terminal output, a URL dropped on the canvas — would otherwise load inside
  // Electron with the preload API attached. Links go to the system browser.
  const indexUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== indexUrl) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
  // Start the Win32 helper eagerly so the drop-to-attach hook is live
  ensureEmbedHelper();
  // Agent bus: loopback only, token in the env of every spawned terminal.
  bus.start(app.getPath('userData'), (evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('bus:event', evt);
    if (remote) remote.onBusEvent(evt);
  });
  startRemote();
}

// Best-effort, async: write/update the Start Menu shortcut that gives our
// AUMID an icon (see src/win-shortcut.ps1). Never blocks startup.
function ensureStartMenuShortcut(iconPath, appRoot) {
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'win-shortcut.ps1'),
      '-Target', process.execPath,
      '-AppArgs', appRoot,
      '-Icon', iconPath,
      '-Aumid', 'com.termivin.app',
    ], { stdio: 'ignore', windowsHide: true, detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// ---------- PTY IPC ----------

// A GUI app launched from the Dock inherits launchd's bare PATH, and Homebrew,
// nvm and asdf all install their setup into ~/.zprofile — which only a login
// shell reads. Terminal.app and iTerm2 start login shells for exactly this
// reason, so `claude` and `codex` resolve there but would not here. Linux
// terminals conventionally don't, so this stays macOS-only.
function loginShellArgs(shell) {
  if (process.platform !== 'darwin') return [];
  return /\/(zsh|bash|sh|fish)$/.test(shell || '') ? ['-l'] : [];
}

// Launched from inside a Claude Code session (e.g. `termivin` typed in one),
// the app inherits that session's markers — and a `claude` started in our
// terminals then believes it is a child session (it even stops saving its
// transcript). Terminals get the user's environment, not that session's.
const INHERITED_SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_\w+))$/;

function terminalEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED_SESSION_VARS.test(k)) delete env[k];
  return env;
}

function busEnv(termId, spaceId, name) {
  const { url } = bus.info();
  if (!url) return {};
  return {
    TERMIVIN_URL: url,
    // bound to this terminal's id — see agentToken in agent-bus.js
    TERMIVIN_TOKEN: bus.agentToken(termId),
    TERMIVIN_AGENT: termId,
    TERMIVIN_SPACE: spaceId || '',
    TERMIVIN_NAME: name || '',
  };
}

ipcMain.handle('pty:create', (event, opts) => {
  if (!pty) return { ok: false, error: 'node-pty is not available: ' + ptyLoadError };
  const { id, shell, args = [], cwd, command, cols = 80, rows = 24, space, name } = opts;

  // If a pty with this id is still alive, kill it first
  const existing = ptys.get(id);
  if (existing) {
    try { existing.kill(); } catch {}
    ptys.delete(id);
  }

  let proc;
  try {
    proc = pty.spawn(shell, args.length ? args : loginShellArgs(shell), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath('home'),
      env: {
        ...terminalEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // Agent bus credentials — an agent needs no config beyond these.
        ...busEnv(id, space, name),
      },
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  ptys.set(id, proc);
  hub.start(id, { cols, rows, pid: proc.pid });

  // Ids are reused (restart, reload → restore), and a killed process reports
  // its exit asynchronously — possibly after a new process took over the id.
  // Only the process currently registered under the id may speak for it.
  proc.onData((data) => {
    if (ptys.get(id) !== proc) return;
    hub.data(id, data);
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', id, data);
  });
  proc.onExit(({ exitCode }) => {
    if (ptys.get(id) !== proc) return;
    ptys.delete(id);
    hub.exit(id, exitCode);
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
    hub.resize(id, cols, rows);
  }
});

ipcMain.on('pty:kill', (event, id) => {
  const p = ptys.get(id);
  if (p) {
    try { p.kill(); } catch {}
    ptys.delete(id);
    hub.stop(id);
  }
});

// ---------- Agent bus ----------

// The renderer owns terminal status, so it pushes the roster on every render
// and status change; the bus uses it for peer lookup and workspace scoping.
ipcMain.on('bus:roster', (event, list) => bus.setRoster(list));
ipcMain.handle('bus:info', () => bus.info());
// The renderer is trusted (it spawns the terminals); tests use this to act as an agent.
ipcMain.handle('bus:agent-token', (event, termId) => bus.agentToken(String(termId)));
ipcMain.handle('bus:pending', (event, termId) => bus.pendingCount(termId));
ipcMain.handle('bus:stats', () => bus.stats());
ipcMain.handle('bus:topic-create', (event, opts) =>
  bus.createTopic(opts.name, opts.spaceId, opts.repId || null));
ipcMain.handle('bus:topic-update', (event, id, patch) => bus.updateTopic(id, patch));
ipcMain.handle('bus:topic-delete', (event, id) => bus.deleteTopic(id));

// ---------- Resource + token usage (dashboards) ----------

// terms: [{ termId, pid? }] — managed terminals resolve their pty pid here;
// external ones pass the pid captured at attach.
ipcMain.handle('stats:sample', async (event, terms) => {
  const roots = [];
  for (const t of terms || []) {
    const proc = ptys.get(t.termId);
    const pid = proc ? proc.pid : t.pid;
    if (pid) roots.push({ key: t.termId, pid });
  }
  try {
    return await procStats.sample(roots);
  } catch (err) {
    return { byKey: {}, app: null, sys: null, error: String(err.message || err) };
  }
});

ipcMain.handle('usage:tokens', () => {
  try {
    return tokenUsage.usage();
  } catch (err) {
    return { error: String(err.message || err) };
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
  // A dead helper surfaces as an async EPIPE on stdin or a spawn 'error' —
  // unhandled, either one would take the whole main process down.
  const proc = embedProc;
  proc.stdin.on('error', (err) => console.error('[win-embed] stdin', err.code || err));
  proc.on('error', (err) => {
    console.error('[win-embed] failed', err.code || err);
    if (embedProc === proc) embedProc = null;
  });
  embedProc.on('exit', () => {
    if (embedProc !== proc) return; // a newer helper already took over
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

// ---------- macOS: adopt external terminal sessions --------------------------
// macOS has no cross-app window reparenting (no SetParent equivalent), so we
// can't embed windows like on Windows. Instead we enumerate real terminal
// *sessions* by process and resolve each one's working directory, letting the
// renderer re-open it as a managed terminal in the same folder.

function macProcCwd(pid) {
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line[0] === 'n') return line.slice(1).trim();
    }
  } catch {}
  return null;
}

function macListTerminals(all) {
  let out;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,args='], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  const procs = [];
  for (const raw of out.split('\n')) {
    const m = raw.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.push({ pid: +m[1], ppid: +m[2], tty: m[3], args: m[4] });
  }
  // Termivin's own managed ptys also have controlling ttys — exclude anything
  // in our process subtree so we don't offer to adopt our own terminals.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isOurs = (pid) => {
    let cur = pid;
    for (let i = 0; cur && i < 100; i++) {
      if (cur === process.pid) return true;
      const p = byPid.get(cur);
      if (!p) return false;
      cur = p.ppid;
    }
    return false;
  };
  const isAgentP = (p) => /\b(claude|codex)\b/i.test(p.args);
  const isShellP = (p) => /(^|\/)-?(zsh|bash|fish|ksh|tcsh|sh)(\s|$)/i.test(p.args);
  const isLoginP = (p) => /(^|\/)login(\s|$)/i.test(p.args);
  const onTty = procs.filter((p) => /^tty/.test(p.tty) && !isOurs(p.pid));
  const groups = new Map();
  for (const p of onTty) {
    if (!groups.has(p.tty)) groups.set(p.tty, []);
    groups.get(p.tty).push(p);
  }
  // Pick the process that represents each terminal (one tty == one pane).
  // Agents (claude/codex) win over the shell that launched them, and both win
  // over helper subprocesses like sourcekit-lsp/caffeinate that would otherwise
  // be the deepest leaf. Falls back to the leaf only when "show all" is on.
  const result = [];
  for (const [tty, group] of groups) {
    const agents = group.filter(isAgentP);
    const shells = group.filter(isShellP);
    let pick, kind;
    if (agents.length) {
      pick = agents.find((p) => {
        const par = byPid.get(p.ppid);
        return par && (isShellP(par) || isLoginP(par));
      }) || agents[0];
      kind = /\bcodex\b/i.test(pick.args) ? 'codex' : 'claude';
    } else if (shells.length) {
      pick = shells[shells.length - 1];
      kind = 'shell';
    } else if (all) {
      const parents = new Set(group.map((p) => p.ppid));
      pick = group.filter((p) => !parents.has(p.pid)).pop() || group[group.length - 1];
      kind = 'shell';
    } else {
      continue;
    }
    const cwd = macProcCwd(pick.pid);
    const cmd = path.basename(pick.args.split(/\s+/)[0].replace(/^-/, ''));
    result.push({
      pid: pick.pid,
      tty,
      proc: kind === 'shell' ? (cmd || 'shell') : kind,
      title: cwd || pick.args,
      cwd: cwd || null,
      kind,
    });
  }
  result.sort((a, b) => a.proc.localeCompare(b.proc) || (a.title || '').localeCompare(b.title || ''));
  return { ok: true, result };
}

ipcMain.handle('external:list', async (event, all) => {
  if (process.platform === 'darwin') return macListTerminals(!!all);
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
  if (process.platform === 'darwin') {
    const cwd = macProcCwd(pid);
    return { ok: true, result: cwd ? [{ name: 'cwd', cwd }] : [] };
  }
  return embedCall('cwds', { pid }, 15000);
});

// Recent Claude Code project directories (from ~/.claude/projects transcripts)
// — used as suggestions when converting an external terminal to a Claude one.
ipcMain.handle('claude:recent-projects', () => recentClaudeProjects());

// Does Claude Code have a saved session for this folder? (--continue needs one)
ipcMain.handle('claude:has-session', (event, cwd) => {
  try {
    const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd || app.getPath('home')));
    return fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
});

function recentClaudeProjects() {
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
}

// ---------- Dialogs ----------

ipcMain.handle('dialog:pick-folder', async (event, defaultPath) => {
  // Without defaultPath, Windows opens wherever the shell last browsed (often
  // Downloads) instead of the folder already typed in the field.
  const opts = { properties: ['openDirectory'] };
  if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
  const res = await dialog.showOpenDialog(win, opts);
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- Remote (self-hosted relay + phone) ----------
// See docs/REMOTE.md. Off until a relay is enrolled in Settings → Remote.

function startRemote() {
  if (remote) return;
  const invokeRenderer = rendererBridge(ipcMain, () => win);
  remote = createRemote({
    userData: app.getPath('userData'),
    hub,
    bus,
    ptys,
    invokeRenderer,
    recentProjects: recentClaudeProjects,
    platform: process.platform,
    version: app.getVersion(),
    notifyRenderer: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  const saved = readState();
  if (saved) remote.setState(saved);
  hub.ready.then(() => remote.start());
}

function pairingText(url, token) {
  return `termivin://pair?u=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;
}

ipcMain.handle('remote:status', () => (remote ? remote.link.info() : { state: 'disabled' }));
ipcMain.handle('remote:enroll', async (event, opts) => {
  try {
    return { ok: true, info: await remote.link.enroll({ url: opts.url, code: opts.code, name: opts.name || os.hostname() }) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle('remote:enable', (event, on) => remote.link.setEnabled(on));
ipcMain.handle('remote:forget', () => remote.link.forget());
ipcMain.handle('remote:pair', async (event, opts = {}) => {
  try {
    const scopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes : ['view', 'approve', 'input', 'manage'];
    const r = await remote.link.createPairing(scopes);
    // The phone may need a different address than this PC (LAN IP vs localhost):
    // the relay's RELAY_PUBLIC_URL wins, else the URL this PC uses.
    const url = opts.url || r.url || remote.link.config.url;
    const text = pairingText(url, r.token);
    const qr = await QRCode.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
    return { ok: true, text, qr, url, token: r.token, expiresAt: r.expiresAt };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});
ipcMain.handle('remote:devices', async () => {
  try {
    return { ok: true, items: await remote.link.listDevices() };
  } catch (err) {
    return { ok: false, error: String(err.message || err), items: [] };
  }
});
ipcMain.handle('remote:revoke', async (event, deviceId) => {
  try {
    return { ok: true, items: await remote.link.revokeDevice(deviceId) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), items: [] };
  }
});

// ---------- Links ----------

// Only web links leave the app; file:, javascript:, custom schemes are dropped.
function openExternalSafe(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
  } catch {}
}

ipcMain.on('os:open-external', (event, url) => openExternalSafe(url));

// ---------- Reveal a terminal's folder ----------

ipcMain.handle('os:open-folder', async (event, dir) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Folder not found: ' + (dir || '(none)') };
  const err = await shell.openPath(dir); // '' on success
  return err ? { ok: false, error: err } : { ok: true };
});

// The VS Code CLI is a shim script (`code.cmd` on Windows), and since Node 20
// spawn() refuses .cmd/.bat unless a shell runs it — so resolve it first and
// only then hand it to a shell, rather than guessing and failing silently.
//
// On macOS the shim is usually missing entirely: it only exists after the user
// runs "Shell Command: Install 'code' command in PATH", and even then it lands
// in /usr/local/bin, which a Dock-launched GUI app does not inherit from
// launchd. Search those directories explicitly, and fall back to `open` below.
const MAC_BIN_DIRS = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin'];

function findEditorCmd() {
  const isWin = process.platform === 'win32';
  const env = { ...process.env };
  if (process.platform === 'darwin') {
    env.PATH = [env.PATH || '', ...MAC_BIN_DIRS].filter(Boolean).join(':');
  }
  for (const name of isWin ? ['code.cmd', 'code'] : ['code']) {
    try {
      const found = execFileSync(isWin ? 'where' : 'which', [name],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
      if (!found) continue;
      // Windows still goes through a shell (the .cmd shim), so keep passing the
      // bare name there: an absolute path with spaces would need quoting.
      return isWin ? name : found;
    } catch {}
  }
  return null;
}

// Without the shim, ask LaunchServices instead. It knows where the app is even
// when it was never moved to /Applications — including the translocated copy
// macOS runs a still-quarantined download from, whose path changes every launch
// and which no PATH entry could ever point at.
function openInVsCodeApp(dir) {
  for (const app of ['Visual Studio Code', 'Visual Studio Code - Insiders']) {
    try {
      execFileSync('/usr/bin/open', ['-a', app, dir], { stdio: 'ignore' });
      return true;
    } catch {}
  }
  return false;
}

ipcMain.handle('os:open-editor', async (event, dir) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Folder not found: ' + (dir || '(none)') };
  const cmd = findEditorCmd();
  if (!cmd) {
    if (process.platform === 'darwin') {
      if (openInVsCodeApp(dir)) return { ok: true };
      return { ok: false, error: 'VS Code was not found. Install it from code.visualstudio.com, or drag it into your Applications folder if you have already downloaded it.' };
    }
    return {
      ok: false,
      error: "VS Code's `code` command isn't on your PATH. In VS Code run "
        + '"Shell Command: Install \'code\' command in PATH" and try again.',
    };
  }
  return await new Promise((resolve) => {
    // Only Windows needs a shell (see findEditorCmd); elsewhere we hold an
    // absolute path, so spawn it directly and skip the quoting dance.
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(cmd, [`"${dir}"`], { detached: true, stdio: 'ignore', shell: true, windowsHide: true })
      : spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    child.once('error', (err) => resolve({ ok: false, error: err.message }));
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
});

// ---------- Clipboard ----------
// xterm has no clipboard access of its own; the renderer asks us instead.

ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (event, text) => clipboard.writeText(String(text ?? '')));

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
  if (remote) remote.stop();
  bus.stop();
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
