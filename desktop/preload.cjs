const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flydropDesktop', {
  settings: () => ipcRenderer.invoke('flydrop:settings'),
  chooseFolder: () => ipcRenderer.invoke('flydrop:choose-folder'),
  setAutostart: enabled => ipcRenderer.invoke('flydrop:autostart', enabled),
  saveFile: id => ipcRenderer.invoke('flydrop:save-file', id),
  sendStagedFile: (recipient, id) => ipcRenderer.invoke('flydrop:send-staged', recipient, id),
  cancelTransfer: () => ipcRenderer.invoke('flydrop:cancel-transfer'),
  onClipboard: callback => { const listener = (_event, text) => callback(text); ipcRenderer.on('flydrop:clipboard', listener); return () => ipcRenderer.removeListener('flydrop:clipboard', listener); },
  onClipboardFiles: callback => { const listener = (_event, files) => callback(files); ipcRenderer.on('flydrop:clipboard-files', listener); return () => ipcRenderer.removeListener('flydrop:clipboard-files', listener); },
  onTransferProgress: callback => { const listener = (_event, progress) => callback(progress); ipcRenderer.on('flydrop:progress', listener); return () => ipcRenderer.removeListener('flydrop:progress', listener); },
  onTransferLock: callback => { const listener = (_event, locked) => callback(locked); ipcRenderer.on('flydrop:transfer-lock', listener); return () => ipcRenderer.removeListener('flydrop:transfer-lock', listener); },
  onMessage: callback => { const listener = (_event, text) => callback(text); ipcRenderer.on('flydrop:message', listener); return () => ipcRenderer.removeListener('flydrop:message', listener); },
  setLanguage: lang => ipcRenderer.invoke('flydrop:language', lang),
  sendToPhone: () => ipcRenderer.invoke('flydrop:send-buffer'),
  chooseUnloadFolder: () => ipcRenderer.invoke('flydrop:unload-folder'),
  openPath: folder => ipcRenderer.invoke('flydrop:open-path', folder),
  windowControls: {
    minimize: () => ipcRenderer.invoke('flydrop:win', 'minimize'),
    toggleMax: () => ipcRenderer.invoke('flydrop:win', 'maximize'),
    close: () => ipcRenderer.invoke('flydrop:win', 'close'),
  },
});
