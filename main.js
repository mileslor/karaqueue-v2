const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

let mainWindow;
let tray;
const PORT = 3000;

function getIconPath(name) {
  const p = path.join(__dirname, 'assets', name);
  return fs.existsSync(p) ? p : null;
}

function isPortInUse(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '0.0.0.0');
  });
}

function startServer() {
  try {
    require('./server');
  } catch (e) {
    dialog.showErrorBox('KaraQueue 錯誤', `無法啟動伺服器：${e.message}`);
    app.quit();
  }
}

function createWindow() {
  const iconPath = getIconPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: 'KaraQueue',
    icon: iconPath || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  mainWindow.on('close', e => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = getIconPath('tray.png') || getIconPath('icon.png');
  const img = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('KaraQueue - KTV 點歌系統');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打開控制台', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: '開啟電視畫面', click: () => shell.openExternal(`http://localhost:${PORT}/tv`) },
    { type: 'separator' },
    { label: '離開 KaraQueue', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

app.whenReady().then(async () => {
  const inUse = await isPortInUse(PORT);

  if (inUse) {
    // Another instance (or leftover process) already has port 3000 — just connect to it
    const choice = await dialog.showMessageBox({
      type: 'warning',
      title: 'KaraQueue',
      message: `Port ${PORT} 已被佔用`,
      detail: '可能已有另一個 KaraQueue 在運行。\n要連接到現有伺服器，還是強制重啟？',
      buttons: ['連接現有伺服器', '離開'],
      defaultId: 0,
    });
    if (choice.response === 1) { app.quit(); return; }
    // Connect to existing server without starting a new one
  } else {
    startServer();
    // Small delay for server to bind
    await new Promise(r => setTimeout(r, 800));
  }

  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('activate', () => {
  mainWindow.show();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
