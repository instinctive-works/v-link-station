const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, Menu, session } = require('electron/main');
const path = require('path');

// DPI / 鬮倩ｧ｣蜒丞ｺｦ蟇ｾ蠢懶ｼ・PU 譛牙柑縺ｮ縺ｾ縺ｾ縺ｫ縺励※繝・く繧ｹ繝医Ξ繝ｳ繝繝ｪ繝ｳ繧ｰ繧帝ｫ伜刀雉ｪ縺ｫ菫昴▽・・app.commandLine.appendSwitch('high-dpi-support', '1');
// 繝阪う繝・ぅ繝悶Γ繝九Η繝ｼ繝舌・(File/Edit...)繧貞ｮ悟・蜑企勁
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
    width: 1920,
    height: 1080,
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
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startServer();

  // Add COOP/COEP headers at the Electron session level so SharedArrayBuffer
  // is available even before the Express server has a chance to set them.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

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

