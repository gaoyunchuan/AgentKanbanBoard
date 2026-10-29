// Codex Thread Kanban Electron 外壳：原生 Chromium 侧边浏览器 + Rust 后端 sidecar。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { BrowserManager } = require('./lib/browser-manager');
const { startBrowserMcp } = require('./lib/browser-mcp');

app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion');
if (process.env.AKB_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.AKB_DEBUG_PORT);

function sidecarPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'akb_sidecar'),
    path.resolve(__dirname, '../src-tauri/target/release/akb_sidecar'),
    path.resolve(__dirname, '../src-tauri/target/debug/akb_sidecar'),
  ];
  return candidates.find(file => existsSync(file));
}

function startSidecar(mcpUrl) {
  const binary = sidecarPath();
  if (!binary) throw new Error('找不到 akb_sidecar 后端可执行文件');
  const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AKB_BROWSER_MCP_URL: mcpUrl || '' } });
  const pending = new Map(); let next = 1;
  const ready = new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.sidecar) { resolve(Number(value.sidecar)); return; }
      if (value.event === 'workbench/changed') { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('backend:changed'); return; }
      const task = pending.get(value.id); if (!task) return; pending.delete(value.id);
      value.error ? task.reject(new Error(value.error)) : task.resolve(value.result);
    });
    child.once('exit', code => reject(new Error('后端 sidecar 已退出：' + code)));
  });
  const call = (method, params) => ready.then(port => new Promise((resolve, reject) => {
    const socket = require('node:net').createConnection(port, '127.0.0.1');
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); socket.destroy(); reject(new Error('后端响应超时')); }, 120000);
    pending.set(id, { resolve: value => { clearTimeout(timer); socket.end(); resolve(value); }, reject: error => { clearTimeout(timer); socket.end(); reject(error); } });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        const task = pending.get(value.id); if (!task) continue;
        pending.delete(value.id);
        value.error ? task.reject(new Error(value.error)) : task.resolve(value.result);
      }
    });
    socket.on('error', error => { clearTimeout(timer); pending.delete(id); reject(error); });
    socket.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
  }));
  return { call, child };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440, height: 920, title: 'Codex Thread Kanban', backgroundColor: '#f6f7f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  const browsers = new BrowserManager(window);
  // Agent 的 session_browser 工具直接操作面板里的原生页面。
  const mcp = await startBrowserMcp(browsers, () => browsers.activeConversation);
  if (process.env.AKB_DEBUG_PORT) console.log('browser-mcp', mcp.url);
  const backend = startSidecar(mcp.url);
  const uiFile = path.join(__dirname, 'ui/index.html');
  window.loadFile(existsSync(uiFile) ? uiFile : path.resolve(__dirname, '../src-ui/dist/index.html'));

  ipcMain.handle('backend:invoke', async (_event, command, args) => {
    if (command === 'chat_browser') {
      return browsers.handle(args.conversationId, args.method, args.params || {});
    }
    return backend.call(command, args || {});
  });
  ipcMain.on('browser:rect', (_event, payload) => browsers.setRect(payload.conversationId, payload.rect));
  ipcMain.on('browser:hide', () => browsers.hide());
  ipcMain.handle('browser:open-downloads', () => { shell.openPath(browsers.downloadPath()); return { opened: true }; });
  window.on('closed', () => { browsers.dispose(); backend.child.kill(); app.quit(); });
});
