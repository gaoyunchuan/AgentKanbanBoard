// Electron PoC：原生 Chromium 嵌入侧边浏览器，同时暴露 CDP 端点供 Agent 使用。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { loadConversations, partitionFor } = require('./lib/sessions');
const { BrowserManager } = require('./lib/browser-manager');

const options = Object.fromEntries(process.argv.slice(2).filter(value => value.startsWith('--')).map(value => {
  const index = value.indexOf('=');
  return index < 0 ? [value.slice(2), true] : [value.slice(2, index), value.slice(index + 1)];
}));
const database = options.db || path.join(process.env.HOME || '', '.codex-kanban/app.db');
const debugPort = String(options['debug-port'] || 9333);
// 每个 PoC 实例可指定独立 profile 根目录，便于验证跨重启的登录态持久化。
if (options['user-data-dir']) app.setPath('userData', path.resolve(String(options['user-data-dir'])));
// 必须在 ready 之前打开；agent-browser 通过该端口以 CDP 操作同一批内嵌页面。
app.commandLine.appendSwitch('remote-debugging-port', debugPort);
app.commandLine.appendSwitch('remote-allow-origins', '*');

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 860, title: 'Electron 浏览器 PoC',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  const browsers = new BrowserManager(window);
  window.loadFile(path.join(__dirname, 'renderer/index.html'));

  ipcMain.handle('sessions:list', () => loadConversations(database));
  ipcMain.handle('browser:show', (_event, { conversationId, url }) => browsers.show(conversationId, url));
  ipcMain.handle('browser:navigate', (_event, { conversationId, url }) => browsers.navigate(conversationId, url));
  ipcMain.handle('browser:history', (_event, { conversationId, action }) => browsers.history(conversationId, action));
  ipcMain.handle('browser:list', () => browsers.list());
  ipcMain.handle('poc:info', () => ({ database, debugPort, partitions: browsers.list() }));
  ipcMain.handle('session:partition', (_event, conversationId) => partitionFor(conversationId));
  ipcMain.handle('poc:flush', async () => {
    for (const entry of browsers.views.values()) {
      const ses = entry.view.webContents.session;
      await ses.cookies.flushStore().catch(() => {});
      ses.flushStorageData();
    }
    return { flushed: true };
  });

  app.on('window-all-closed', () => { browsers.dispose(); app.quit(); });
});
