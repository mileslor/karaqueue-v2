const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

let proxyServer = null;
let setupWin = null;
let tvWin = null;

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520,
    height: 480,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

app.whenReady().then(createSetupWindow);

app.on('window-all-closed', () => {
  if (proxyServer) { proxyServer.close(); proxyServer = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!setupWin && !tvWin) createSetupWindow();
});

// Fetch rooms from server (in main process to avoid CORS issues)
ipcMain.handle('fetch-rooms', async (_e, serverUrl) => {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/rooms`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, rooms: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('create-room', async (_e, { serverUrl, name, color }) => {
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, room: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('start-tv', (event, { serverUrl, roomId }) => {
  const target = serverUrl.replace(/\/$/, '');

  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }

  // Lazy-load http-proxy so startup stays fast
  let httpProxy;
  try {
    httpProxy = require('http-proxy');
  } catch (_) {
    event.sender.send('proxy-error', 'http-proxy module 未安裝，請先 npm install');
    return;
  }

  const proxy = httpProxy.createProxyServer({
    target,
    ws: true,
    changeOrigin: true,
  });

  proxy.on('error', (err, req, res) => {
    console.error('[proxy]', err.message);
    if (res && res.writeHead) {
      try { res.writeHead(502); res.end('Proxy error'); } catch (_) {}
    }
  });

  proxyServer = http.createServer((req, res) => proxy.web(req, res));
  proxyServer.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));

  proxyServer.listen(0, '127.0.0.1', () => {
    const port = proxyServer.address().port;
    const tvUrl = `http://localhost:${port}/tv?room=${encodeURIComponent(roomId || 'default')}`;

    tvWin = new BrowserWindow({
      fullscreen: true,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    tvWin.loadURL(tvUrl);

    tvWin.on('closed', () => {
      tvWin = null;
      if (proxyServer) { proxyServer.close(); proxyServer = null; }
      createSetupWindow();
    });

    if (setupWin) {
      setupWin.close();
    }
  });
});
