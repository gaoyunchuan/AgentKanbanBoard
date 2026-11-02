// 把现有 Tauri invoke 调用桥接到 Electron IPC；渲染页面只拿到最小能力。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (command, args) => ipcRenderer.invoke('backend:invoke', command, args);
contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', { invoke, transformCallback: () => 0 });
contextBridge.exposeInMainWorld('akb', {
  platform: process.platform,
  browser: true,
  invoke,
  rect: payload => ipcRenderer.send('browser:rect', payload),
  hide: () => ipcRenderer.send('browser:hide'),
  onBrowserChanged: callback => {
    const listener=(_event,state)=>callback(state);ipcRenderer.on('browser:changed',listener);
    return ()=>ipcRenderer.removeListener('browser:changed',listener);
  },
  openDownloads: () => ipcRenderer.invoke('browser:open-downloads'),
});
