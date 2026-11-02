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
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('后端启动超时，请检查连接状态')), 120000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.sidecar) { resolve(Number(value.sidecar)); return; }
      if (value.event === 'workbench/changed') { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('backend:changed'); return; }
      const task = pending.get(value.id); if (!task) return; pending.delete(value.id);
      value.error ? task.reject(new Error(value.error)) : task.resolve(value.result);
    });
    child.once('exit', code => reject(new Error('后端 sidecar 已退出：' + code)));
    child.once('error', reject);
    child.once('close', code => reject(new Error('后端 sidecar 已关闭：' + code)));
  });
  // 启动失败也由调用方呈现；先处理拒绝，避免前端尚未加载时触发未处理异常。
  ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));
  let backendError = null;
  const failPending = error => { backendError = error; for (const task of [...pending.values()]) task.reject(error); };
  child.once('error', failPending);
  child.once('exit', () => failPending(new Error('后端 sidecar 已退出')));
  const call = (method, params) => ready.then(port => new Promise((resolve, reject) => {
    if (backendError) { reject(backendError); return; }
    // 传输背压只约束在途 RPC，不占 Agent 并发，也不互斥终端进程。
    if (pending.size >= 16) { reject(new Error('后端请求较多，请稍后重试')); return; }
    const socket = require('node:net').createConnection(port, '127.0.0.1');
    const id = next++;
    let buffer = '', bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); pending.delete(id); buffer = '';
      // end() 仅半关闭；服务端曾持有广播 writer 克隆，导致 socket 和 Promise 结果永久滞留。
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('后端响应超时')), 120000);
    pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 32 * 1024 * 1024) { finish(new Error('后端响应超过 32 MiB，请缩小读取范围')); return; }
      buffer += chunk;
      let index;
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { finish(new Error('后端响应格式无效')); return; }
        if (value.event === 'workbench/changed') continue;
        if (value.id !== id) continue;
        value.error ? finish(new Error(String(value.error))) : finish(null, value.result);
      }
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new Error('后端连接提前结束，操作结果需要核对')));
    socket.on('close', () => finish(new Error('后端连接已关闭，操作结果需要核对')));
    try { socket.write(JSON.stringify({ id, method, params: params || {} }) + '\n'); }
    catch (error) { finish(error); }
  }));
  return { call, child };
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1440, height: 920, title: 'Codex Thread Kanban', backgroundColor: '#f6f7f9',
    // 原生窗口按钮与页面操作共用顶栏，避免另占一条系统标题栏。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : { titleBarOverlay: { color: '#f8f9fb', symbolColor: '#475569', height: 52 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  const browsers = new BrowserManager(window);
  // Agent 的 session_browser 工具直接操作面板里的原生页面。
  let backend;
  const mcp = await startBrowserMcp(browsers, async taskId => {
    if (!taskId || !backend) return null;
    try {
      const snapshot = await backend.call('chat_command', { method: 'snapshot', params: {} });
      const conversation = (snapshot.conversations || []).find(item => item.task_id === taskId);
      return conversation ? conversation.id : null;
    } catch { return null; }
  });
  if (process.env.AKB_DEBUG_PORT) console.log('browser-mcp', mcp.url);
  backend = startSidecar(mcp.url);
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
  let shuttingDown = false;
  window.on('close', event => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true;
    // 先清理本应用拥有的 PTY 和 app-server，再退出 sidecar，避免终端变成孤儿。
    Promise.race([backend.call('workbench_shutdown', {}), new Promise(resolve => setTimeout(resolve, 5000))])
      .catch(() => {}).finally(() => { browsers.dispose(); backend.child.kill(); window.destroy(); app.quit(); });
  });
});
