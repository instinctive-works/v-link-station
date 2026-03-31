const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  getSources:    (opts) => ipcRenderer.invoke('desktopCapture:getSources', opts),
});
