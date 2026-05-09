const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startTV: (opts) => ipcRenderer.send('start-tv', opts),
  fetchRooms: (serverUrl) => ipcRenderer.invoke('fetch-rooms', serverUrl),
  createRoom: (serverUrl, name, color) => ipcRenderer.invoke('create-room', { serverUrl, name, color }),
  onError: (cb) => ipcRenderer.on('proxy-error', (_e, msg) => cb(msg)),
});
