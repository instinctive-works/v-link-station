const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDirectory:  () => ipcRenderer.invoke('dialog:openDirectory'),
  getSources:     (opts) => ipcRenderer.invoke('desktopCapture:getSources', opts),
  // 仮想カメラへ JPEG フレームを送信（width, height: number, jpeg: ArrayBuffer）
  sendVcamFrame:  (width, height, jpeg) =>
    ipcRenderer.send('vcam:frame', { width, height, jpeg }),
});
