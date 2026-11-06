// Codex Thread Kanban Electron 外壳：原生 Chromium 侧边浏览器 + Rust 后端 sidecar。
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const readline = require('node:readline');
const { bindWorkspaceMenu } = require('./lib/workspace-shortcuts');
const { BrowserManager } = require('./lib/browser-manager');
const { startBrowserMcp } = require('./lib/browser-mcp');
const { startJoyCodeBridge } = require('./lib/joycode-bridge');

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

function startSidecar(mcpUrl, joycode) {
  const binary = sidecarPath();
  if (!binary) throw new Error('找不到 akb_sidecar 后端可执行文件');
  const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AKB_BROWSER_MCP_URL: mcpUrl || '', AKB_JOYCODE_BRIDGE_URL: joycode?.url || '', AKB_JOYCODE_BRIDGE_KEY: joycode?.key || '' } });
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
    const fragments = [];
    let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); pending.delete(id); fragments.length = 0;
      // end() 仅半关闭；服务端曾持有广播 writer 克隆，导致 socket 和 Promise 结果永久滞留。
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('后端响应超时')), 120000);
    pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { finish(new Error('后端响应超过 32 MiB，请缩小读取范围')); return; }
      // 只查找新收到的字节。长历史拆成多个 TCP 分片时，等到行尾才拼接并解码一次。
      for (let offset = 0; !settled && offset < chunk.length;) {
        const end = chunk.indexOf(10, offset);
        if (end === -1) {
          fragments.push(chunk.subarray(offset));
          break;
        }
        fragments.push(chunk.subarray(offset, end));
        const line = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        fragments.length = 0;
        offset = end + 1;
        let value;
        try { value = JSON.parse(line.toString('utf8')); } catch { finish(new Error('后端响应格式无效')); return; }
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
  const database = process.env.AGENT_KANBAN_DB_PATH || path.join(app.getPath('home'), '.codex-kanban', 'app.db');
  const storageScope = createHash('sha256').update(path.resolve(database)).digest('hex').slice(0, 24);
  const window = new BrowserWindow({
    width: 1440, height: 920, title: 'Codex Thread Kanban', backgroundColor: '#f6f7f9',
    // 原生窗口按钮与页面操作共用顶栏，避免另占一条系统标题栏。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : { titleBarOverlay: { color: '#f8f9fb', symbolColor: '#475569', height: 52 } }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, additionalArguments: ['--akb-storage-scope=' + storageScope] },
  });
  const browsers = new BrowserManager(window, {
    manifest: path.join(app.getPath('userData'), 'workspace-tabs', storageScope + '.json'),
    ...(process.env.AGENT_KANBAN_DB_PATH ? { downloads: path.join(path.dirname(database), 'downloads') } : {}),
  });
  bindWorkspaceMenu(Menu, window, () => browsers.shortcuts, process.platform, () =>
    browsers.visible && browsers.activeContents(browsers.activeConversation)?.isFocused()
      ? browsers.activeConversation : undefined);
  // Agent 的 session_browser 工具直接操作面板里的原生页面。
  let backend;
  const completing = new Set();
  let workspaceRevision = 0;
  const mcp = await startBrowserMcp(browsers, async taskId => {
    if (!taskId || !backend) return null;
    let snapshot;
    try {
      snapshot = await backend.call('chat_command', { method: 'snapshot', params: {} });
    } catch { return null; }
    const conversation = (snapshot.conversations || []).find(item => item.mode === 'auto'
      ? item.task_id === taskId : `chat:${item.id}` === taskId)
      || (snapshot.conversations || []).find(item => item.task_id === taskId);
    if (conversation?.closed || completing.has(conversation?.id)) throw new Error('会话已完成或正在完成');
    return conversation?.id || null;
  });
  if (process.env.AKB_DEBUG_PORT) console.log('browser-mcp', mcp.url);
  const joycode = process.platform === 'darwin' ? await startJoyCodeBridge().catch(() => null) : null;
  backend = startSidecar(mcp.url, joycode);
  const uiFile = path.join(__dirname, 'ui/index.html');
  window.loadFile(existsSync(uiFile) ? uiFile : path.resolve(__dirname, '../src-ui/dist/index.html'));

  ipcMain.handle('backend:invoke', async (_event, command, args) => {
    if (command === 'chat_browser') {
      const { conversationId, method, params } = args;
      if (['new_page', 'open_page', 'navigate'].includes(method)) {
        const revision = workspaceRevision;
        const owner = await backend.call('chat_command', { method: 'browser_owner', params: { conversation_id: conversationId } });
        if (owner.closed || completing.has(conversationId)) throw new Error('请先恢复会话，再打开网页');
        if (revision !== workspaceRevision) throw new Error('会话状态已变化，请重试打开网页');
      }
      return browsers.handle(conversationId, method, params || {});
    }
    if (command === 'chat_command') {
      const { method, params } = args;
      const owner = params?.conversation_id;
      if (typeof owner === 'string' && ['complete_conversation', 'close_conversation'].includes(method)) {
        if (completing.has(owner)) throw new Error('会话正在完成');
        completing.add(owner);
        workspaceRevision++;
        try {
          const result = await backend.call(command, args);
          if (result.closed) browsers.releaseConversation(owner);
          return result;
        } finally {
          completing.delete(owner);
          workspaceRevision++;
        }
      }
      if (method === 'snapshot') {
        const revision = workspaceRevision;
        const snapshot = await backend.call(command, args);
        // 轮询同时回收旧版留下的已完成网页。明确恢复期间的旧快照不能清掉新网页。
        if (revision === workspaceRevision) {
          for (const conversation of snapshot.conversations) {
            if (conversation.closed) browsers.releaseConversation(conversation.id);
          }
        }
        return snapshot;
      }
      if (['reopen_conversation', 'work_action', 'task_state'].includes(method)) {
        workspaceRevision++;
        try { return await backend.call(command, args); }
        finally { workspaceRevision++; }
      }
    }
    return backend.call(command, args || {});
  });
  ipcMain.on('browser:rect', (_event, payload) => {
    try { browsers.setRect(payload.conversationId, payload.rect); }
    catch (error) { window.webContents.send('browser:notice', error.message); }
  });
  ipcMain.on('workspace:shortcuts', (event, value) => {
    if (event.sender === window.webContents) browsers.setShortcuts(value);
  });
  ipcMain.on('browser:hide', () => browsers.hide(true));
  ipcMain.handle('browser:open-downloads', () => { shell.openPath(browsers.downloadPath()); return { opened: true }; });
  let shuttingDown = false;
  window.on('close', event => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true;
    // 先清理本应用拥有的 PTY 和 app-server，再退出 sidecar，避免终端变成孤儿。
    Promise.race([backend.call('workbench_shutdown', {}), new Promise(resolve => setTimeout(resolve, 5000))])
      .catch(() => {}).finally(() => { joycode?.close(); browsers.dispose(); backend.child.kill(); window.destroy(); app.quit(); });
  });
});
