const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

contextBridge.exposeInMainWorld('termivin', {
  platform: process.platform,
  homedir: os.homedir(),

  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyKill: (id) => ipcRenderer.send('pty:kill', id),

  onPtyData: (cb) => ipcRenderer.on('pty:data', (e, id, data) => cb(id, data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (e, id, code) => cb(id, code)),

  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  saveStateSync: (state) => ipcRenderer.sendSync('state:save-sync', state),

  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),

  externalList: (all) => ipcRenderer.invoke('external:list', all),
  externalAttach: (opts) => ipcRenderer.invoke('external:attach', opts),
  externalMove: (opts) => ipcRenderer.send('external:move', opts),
  externalShow: (opts) => ipcRenderer.send('external:show', opts),
  externalAlive: (hwnd) => ipcRenderer.invoke('external:alive', hwnd),
  externalDetach: (opts) => ipcRenderer.invoke('external:detach', opts),
  externalClose: (hwnd) => ipcRenderer.invoke('external:close', hwnd),
  externalCwds: (pid) => ipcRenderer.invoke('external:cwds', pid),
  externalIsAttached: (hwnd) => ipcRenderer.invoke('external:is-attached', hwnd),
  claudeRecentProjects: () => ipcRenderer.invoke('claude:recent-projects'),
  onExternalDropped: (cb) => ipcRenderer.on('external:dropped', (e, info) => cb(info)),
});
