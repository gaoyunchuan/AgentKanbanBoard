// 把现有 Tauri invoke 调用桥接到 Electron IPC；渲染页面只拿到最小能力。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (command, args) => ipcRenderer.invoke('backend:invoke', command, args);
contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', { invoke, transformCallback: () => 0 });
contextBridge.exposeInMainWorld('akb', {
  browser: true,
  invoke,
  rect: payload => ipcRenderer.send('browser:rect', payload),
  hide: () => ipcRenderer.send('browser:hide'),
  onBrowserChanged: callback => ipcRenderer.on('browser:changed', (_event, state) => callback(state)),
  openDownloads: () => ipcRenderer.invoke('browser:open-downloads'),
});
