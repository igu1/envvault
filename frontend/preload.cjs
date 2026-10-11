const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('envvault', {
  defaults: () => ipcRenderer.invoke('ev:defaults'),
  chooseDirectory: () => ipcRenderer.invoke('ev:directory'),
  chooseFile: (mode, options) => ipcRenderer.invoke('ev:file', mode, options),
  run: request => ipcRenderer.invoke('ev:run', request),
  copy: (request, seconds) => ipcRenderer.invoke('ev:copy', request, seconds),
  startTerminal: (id, request) => ipcRenderer.invoke('ev:terminal-start', id, request),
  stopTerminal: id => ipcRenderer.invoke('ev:terminal-stop', id),
  stopTerminals: () => ipcRenderer.invoke('ev:terminal-stop-all'),
  writeTerminal: (id, data) => ipcRenderer.send('ev:terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('ev:terminal-resize', id, cols, rows),
  resumeTerminal: id => ipcRenderer.send('ev:terminal-resume', id),
  onTerminal: callback => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('ev:terminal-event', handler);
    return () => ipcRenderer.removeListener('ev:terminal-event', handler);
  },
});
