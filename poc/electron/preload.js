// 只暴露必要桥接，渲染页面拿不到 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('poc', {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  show: (conversationId, url) => ipcRenderer.invoke('browser:show', { conversationId, url }),
  navigate: (conversationId, url) => ipcRenderer.invoke('browser:navigate', { conversationId, url }),
  history: (conversationId, action) => ipcRenderer.invoke('browser:history', { conversationId, action }),
  listBrowsers: () => ipcRenderer.invoke('browser:list'),
  info: () => ipcRenderer.invoke('poc:info'),
  flush: () => ipcRenderer.invoke('poc:flush'),
  onChanged: callback => ipcRenderer.on('browser:changed', (_event, state) => callback(state)),
});
