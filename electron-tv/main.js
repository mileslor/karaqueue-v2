const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const http = require('http');
const path = require('path');

Menu.setApplicationMenu(null);

let proxyServer = null;
let setupWin = null;
let tvWin = null;

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 520,
    height: 560,
    useContentSize: true,
    resizable: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

ipcMain.on('start-tv', (event, { serverUrl, roomId, roomName }) => {
  const target = serverUrl.replace(/\/$/, '');

  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }

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

    // ESC to exit TV and return to setup
    tvWin.webContents.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        tvWin.close();
      }
    });

    // Inject info overlay after page loads
    tvWin.webContents.on('did-finish-load', () => {
      const displayName = roomName || roomId || 'default';
      const displayServer = target.replace(/^https?:\/\//, '');
      tvWin.webContents.executeJavaScript(`
        (function() {
          const bar = document.createElement('div');
          bar.id = '_kq_bar';
          bar.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
            'background:rgba(0,0,0,0.72)', 'backdrop-filter:blur(4px)',
            'color:#fff', 'font-family:system-ui,sans-serif', 'font-size:13px',
            'padding:8px 18px', 'display:flex', 'justify-content:space-between',
            'align-items:center', 'transition:opacity .4s',
          ].join(';');
          bar.innerHTML =
            '<span>🎤 KaraQueue TV &nbsp;·&nbsp; 房間：<b>${displayName}</b> &nbsp;·&nbsp; 伺服器：${displayServer}</span>' +
            '<span style="opacity:.55;font-size:11px">按 ESC 退出 &nbsp;|&nbsp; 按 I 顯示/隱藏資訊</span>';
          document.body.appendChild(bar);
          // Auto-hide after 6 seconds
          setTimeout(() => {
            bar.style.opacity = '0';
            setTimeout(() => { bar.style.pointerEvents = 'none'; }, 400);
          }, 6000);
          // Toggle with "I" key
          document.addEventListener('keydown', function(e) {
            if (e.key === 'i' || e.key === 'I') {
              if (bar.style.opacity === '0' || bar.style.opacity === '') {
                bar.style.opacity = '1';
                bar.style.pointerEvents = 'auto';
              } else {
                bar.style.opacity = '0';
                bar.style.pointerEvents = 'none';
              }
            }
          });
        })();
      `).catch(() => {});
    });

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
