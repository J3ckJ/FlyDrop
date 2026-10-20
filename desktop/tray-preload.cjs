const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flydropTray', {
  onPreview: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('tray:preview', listener); return () => ipcRenderer.removeListener('tray:preview', listener); },
  send: () => ipcRenderer.invoke('tray:send'),
  open: () => ipcRenderer.invoke('tray:open'),
  browser: () => ipcRenderer.invoke('tray:browser'),
  quit: () => ipcRenderer.invoke('tray:quit'),
});
