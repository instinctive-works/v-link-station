const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, Menu } = require('electron/main');
const path = require('path');

// GPU プロセスが利用できない環境（VM・RDP など）でのクラッシュを防ぐ
app.commandLine.appendSwitch('--disable-gpu');
app.commandLine.appendSwitch('--disable-gpu-sandbox');
// DPI / 高解像度対応
app.commandLine.appendSwitch('high-dpi-support', '1');
// ネイティブメニューバー(File/Edit...)を完全削除
Menu.setApplicationMenu(null);
const { fork } = require('child_process');

const SERVER_PORT = 3000;
let mainWindow = null;
let serverProcess = null;

function startServer() {
  const serverPath = path.join(__dirname, '..', '..', '..', 'apps', 'server', 'server.js');
  serverProcess = fork(serverPath, [], {
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'V-Link Station',
  });

  mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();

  // Wait for the server process to signal it is ready before opening the window.
  // Fall back to a 4-second timeout in case the IPC message is never sent.
  let windowCreated = false;
  const fallback = setTimeout(() => {
    if (!windowCreated) { windowCreated = true; createWindow(); }
  }, 4000);

  serverProcess.on('message', (msg) => {
    if (msg && msg.type === 'ready' && !windowCreated) {
      windowCreated = true;
      clearTimeout(fallback);
      createWindow();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
});

// IPC: open directory picker for recording path
ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// IPC: list desktop capture sources (screens + windows)
ipcMain.handle('desktopCapture:getSources', async (_event, opts) => {
  const types = (opts && opts.types) || ['screen', 'window'];
  const sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 0, height: 0 } });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});
