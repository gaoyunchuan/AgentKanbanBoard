/** Owned, isolated Chrome bridge. JSONL in/out; no shell or existing user profile. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(label + ' timeout')), ms); timer.unref(); })]);
let chrome, profile, endpoint, socket, targetId, nextId = 1;
const requests = new Map();
let cleaning = false;
async function clean() {
  if (cleaning) return;
  cleaning = true;
  try { socket?.close(); } catch {}
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(1800)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
function rejectPending(message) { for (const p of requests.values()) p.reject(new Error(message)); requests.clear(); }
async function discover() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
  for (const executable of candidates) { try { await access(executable); return executable; } catch {} }
  throw new Error('未找到 Chrome/Chromium。请先安装浏览器；不会连接你的日常浏览器。');
}
async function start() {
  if (typeof WebSocket === 'undefined') throw new Error('侧边浏览器需要 Node.js 22 或以上');
  profile = await mkdtemp(path.join(tmpdir(), 'agentkanban-browser-'));
  const args = ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--window-size=1000,800', 'about:blank'];
  // Only used by tests in an isolated Linux container; never exposed via app RPC.
  if (process.env.AKB_BROWSER_CONTAINER_TEST === '1' && process.platform === 'linux') args.unshift('--no-sandbox');
  chrome = spawn(await discover(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  chrome.on('error', e => { launchError = e; });
  chrome.stderr.resume();
  for (let i = 0; i < 120; i++) {
    if (launchError) throw launchError;
    if (chrome.exitCode !== null) throw new Error('Chrome 启动失败');
    try { const lines = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); if (/^\d+$/.test(lines[0])) { endpoint = `http://127.0.0.1:${lines[0]}`; break; } } catch {}
    await delay(100);
  }
  if (!endpoint) throw new Error('Chrome 未返回本地调试端口');
  emit({ ready: true, endpoint });
}
async function targets() {
  const response = await timeout(fetch(endpoint + '/json/list'), 5000, '读取页面');
  if (!response.ok) throw new Error('无法获取浏览器页面');
  return (await response.json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}
async function attach(id) {
  if (socket?.readyState === WebSocket.OPEN && (!id || id === targetId)) return;
  const list = await targets(); const target = list.find(t => t.id === id) || (!id ? list[0] : undefined);
  if (!target) throw new Error('页面已关闭，请刷新标签列表');
  rejectPending('页面已切换'); if (socket) socket.close();
  targetId = target.id; socket = new WebSocket(target.webSocketDebuggerUrl);
  const current = socket;
  socket.onmessage = event => { let data; try { data = JSON.parse(String(event.data)); } catch { return; } const pending = requests.get(data.id); if (pending) { requests.delete(data.id); if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result || {}); } };
  socket.onclose = () => { if (socket === current) rejectPending('浏览器连接已关闭'); };
  await timeout(new Promise((resolve, reject) => { current.onopen = resolve; current.onerror = () => reject(new Error('无法连接浏览器页面')); }), 5000, '连接页面');
  await cdp('Page.enable');
}
function cdp(method, params = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('页面未连接'));
  const id = nextId++;
  return timeout(new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }), 7000, method).finally(() => requests.delete(id));
}
async function dispatch(method, p = {}) {
  if (method === 'status') return { endpoint, pages: await targets(), target_id: targetId };
  await attach(p.target_id);
  if (method === 'frame') {
    const width = Math.max(300, Math.min(1800, Number(p.width) || 900)), height = Math.max(220, Math.min(1400, Number(p.height) || 760));
    await cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(width), height: Math.round(height), deviceScaleFactor: 1, mobile: false });
    const frame = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
    const pages = await targets(); const page = pages.find(t => t.id === targetId);
    return { data: frame.data, width, height, target_id: targetId, url: page?.url || '', title: page?.title || '', pages: pages.map(({ id, title, url }) => ({ id, title, url })) };
  }
  if (method === 'navigate') {
    const url = new URL(String(p.url));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('地址仅支持不含凭据的 HTTP/HTTPS');
    return cdp('Page.navigate', { url: url.href });
  }
  if (method === 'reload') return cdp('Page.reload');
  if (method === 'back' || method === 'forward') { const history = await cdp('Page.getNavigationHistory'); const next = history.entries[history.currentIndex + (method === 'back' ? -1 : 1)]; return next ? cdp('Page.navigateToHistoryEntry', { entryId: next.id }) : {}; }
  if (method === 'click') { const x = Math.max(0, Math.min(1800, Number(p.x))), y = Math.max(0, Math.min(1400, Number(p.y))); if (!Number.isFinite(x + y)) throw new Error('无效坐标'); await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', x, y, clickCount: 1 }); return cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', x, y, clickCount: 1 }); }
  if (method === 'wheel') return cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Number(p.x) || 200, y: Number(p.y) || 200, deltaX: Math.max(-3000, Math.min(3000, Number(p.dx) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(p.dy) || 0)) });
  if (method === 'text') { const text = String(p.text || ''); if (text.length > 50000) throw new Error('一次输入过长'); return cdp('Input.insertText', { text }); }
  if (method === 'key') { const keys = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, a: 65, c: 67, v: 86, x: 88 }; const key = String(p.key || ''); if (!(key in keys)) throw new Error('不支持的按键'); const args = { key, windowsVirtualKeyCode: keys[key], modifiers: Number(p.modifiers) & 15 }; await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...args }); return cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...args }); }
  throw new Error('未知浏览器操作');
}
process.on('SIGTERM', async () => { await clean(); process.exit(0); });
try {
  await start();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    let request; try { request = JSON.parse(line); const result = await dispatch(request.method, request.params); emit({ id: request.id, result }); } catch (error) { emit({ id: request?.id, error: String(error?.message || error) }); }
  }
} catch (error) { emit({ ready: false, error: String(error?.message || error) }); process.exitCode = 1; }
finally { await clean(); }
