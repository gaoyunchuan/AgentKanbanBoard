// 把现有 Tauri invoke 调用桥接到 Electron IPC；渲染页面只拿到最小能力。
const { contextBridge, ipcRenderer } = require('electron');

const scopeArgument = '--akb-storage-scope=';
const storageScope = process.argv.find(value => value.startsWith(scopeArgument))?.slice(scopeArgument.length);
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const invoke = (command, args) => ipcRenderer.invoke('backend:invoke', command, args);
contextBridge.exposeInMainWorld('__TAURI_INTERNALS__', { invoke, transformCallback: () => 0 });
contextBridge.exposeInMainWorld('akb', {
  platform: process.platform,
  storageScope,
  setShortcuts: value => ipcRenderer.send('workspace:shortcuts', value),
  onShortcut: callback => subscribe('workspace:shortcut', callback),
  onBrowserNotice: callback => subscribe('browser:notice', callback),
  browser: true,
  invoke,
  rect: payload => ipcRenderer.send('browser:rect', payload),
  hide: () => ipcRenderer.send('browser:hide'),
  onBrowserChanged: callback => subscribe('browser:changed', callback),
  openDownloads: () => ipcRenderer.invoke('browser:open-downloads'),
});
