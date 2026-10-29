// 端到端：真实 Electron 窗口 + 内嵌 Chromium 原生页面 + 分区隔离 + 重启持久化 + Agent CDP。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFixture } from '../../../scripts/session_browser_probe/fixture.mjs';

const require = createRequire(import.meta.url);
const electron = require('electron');
const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = server.address(); server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('等待 CDP 超时：' + url);
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map(); let next = 1;
  socket.onmessage = event => {
    const reply = JSON.parse(event.data); const task = pending.get(reply.id);
    if (!task) return; pending.delete(reply.id);
    reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result);
  };
  const ready = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('CDP 连接失败')); });
  const request = async (method, params = {}) => {
    await ready; const id = next++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error('CDP 超时 ' + method)); }, 15000).unref?.();
    });
  };
  return { request, close: () => socket.close(), ready };
}

async function evalValue(connection, expression) {
  const reply = await connection.request('Runtime.evaluate', { expression, returnByValue: true });
  return reply.result ? reply.result.value : undefined;
}

async function waitValue(connection, expression, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await evalValue(connection, expression);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('页面状态未就绪：' + expression + ' -> ' + JSON.stringify(last));
}

const directory = mkdtempSync(path.join(tmpdir(), 'akb-electron-e2e-'));
const userData = path.join(directory, 'profile');
const database = path.join(directory, 'app.db');
execFileSync('sqlite3', [database,
  "CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,title TEXT,thread_id TEXT,closed INTEGER DEFAULT 0,updated_at TEXT); INSERT INTO chat_conversations VALUES('conv-a','会话 A',NULL,0,'2026-01-02'),('conv-b','会话 B','thread-b',0,'2026-01-01');"]);
const fixture = await startFixture(() => {});
const fixtureUrl = 'http://127.0.0.1:' + fixture.port + '/typing';
const trace = [];

async function startApp(port, userDir) {
  const started = Date.now();
  const child = spawn(electron, ['.', '--db=' + database, '--debug-port=' + port, '--user-data-dir=' + userDir], {
    cwd: path.resolve(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  const base = 'http://127.0.0.1:' + port;
  try { await waitForJson(base + '/json/version'); }
  catch (error) { throw new Error(String(error) + '\n' + stderr.slice(-2000)); }
  const targets = await waitForJson(base + '/json/list');
  const windowTarget = targets.find(target => target.type === 'page' && target.url.includes('renderer/index.html'));
  assert.ok(windowTarget, '找不到 PoC 窗口目标');
  return { child, base, windowTarget, started };
}

async function stopApp(app) {
  app.child.kill('SIGTERM');
  await new Promise(resolve => { app.child.once('exit', resolve); setTimeout(resolve, 5000).unref?.(); });
}

async function openSession(ui, id, url) {
  await ui.request('Runtime.evaluate', { expression: 'window.poc.show(' + JSON.stringify(id) + ', ' + JSON.stringify(url) + ')', awaitPromise: true, returnByValue: true });
}

async function findPage(base, url, exclude) {
  for (let index = 0; index < 150; index++) {
    const list = await waitForJson(base + '/json/list');
    const found = list.find(target => target.type === 'page' && target.url.startsWith(url) && (!exclude || target.id !== exclude));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('内嵌页面没有出现在 CDP 目标中：' + url);
}

async function runFirstLaunch() {
  const port = await freePort();
  const app = await startApp(port, userData);
  const ui = connect(app.windowTarget.webSocketDebuggerUrl);
  await waitValue(ui, "document.querySelectorAll('#sessions button').length", value => value === 2);
  const sessions = (await ui.request('Runtime.evaluate', { expression: 'window.poc.listSessions()', awaitPromise: true, returnByValue: true })).result.value;
  assert.deepEqual(sessions.map(value => value.id), ['conv-a', 'conv-b']);
  const shownA = await ui.request('Runtime.evaluate', { expression: 'window.poc.show("conv-a", ' + JSON.stringify(fixtureUrl) + ')', awaitPromise: true, returnByValue: true });
  assert.ok(shownA.result.value.bounds && shownA.result.value.bounds.width > 100 && shownA.result.value.bounds.height > 100, '会话视图应在窗口内占据可见区域');
  const pageATarget = await findPage(app.base, fixtureUrl);
  const pageA = connect(pageATarget.webSocketDebuggerUrl);
  const markerA = await waitValue(pageA, '({ready:document.readyState,text:document.querySelector("#text")?.placeholder||null})', value => value && value.ready === 'complete' && value.text);
  // 会话 Cookie 不会落盘，持久化验证必须用带 Max-Age 的 Cookie。
  await pageA.request('Runtime.evaluate', { expression: "document.cookie='probe=A; path=/; max-age=86400'", returnByValue: true });
  const cookieA = await evalValue(pageA, 'document.cookie');
  assert.match(String(markerA.text), /输入/, '内嵌页面应原生渲染网页 DOM');
  assert.match(String(cookieA), /probe=A/);
  const glyphs = await evalValue(pageA, "(()=>{const paint=ch=>{const c=document.createElement('canvas');c.width=64;c.height=64;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,64,64);x.fillStyle='#000';x.font='48px sans-serif';x.fillText(ch,4,52);const d=x.getImageData(0,0,64,64).data;let h=0,n=0;for(let i=0;i<d.length;i+=4){if(d[i]<128)n++;h=(h*31+d[i])>>>0}return{hash:h,ink:n}};return{zhong:paint('中'),wen:paint('文')}})()");
  assert.notEqual(glyphs.zhong.hash, glyphs.wen.hash, '中文字符应渲染为真实字形而不是缺字方框');
  assert.ok(glyphs.zhong.ink > 100);
  trace.push({ step: '首次启动 A 页面原生渲染', ms: Date.now() - app.started, value: { text: markerA.text, cookie: cookieA } });
  await openSession(ui, 'conv-b', fixtureUrl);
  const pageB = connect((await findPage(app.base, fixtureUrl, pageATarget.id)).webSocketDebuggerUrl);
  const markerB = await waitValue(pageB, '({ready:document.readyState,cookie:document.cookie,text:document.querySelector("#text")?.placeholder||null})', value => value && value.ready === 'complete' && value.text);
  assert.equal(markerB.cookie, '', '不同会话不得共享 Cookie 分区');
  trace.push({ step: 'A/B 分区隔离', value: markerB });
  const agent = path.join(repo, '.build/browser/agent-browser');
  const listing = execFileSync(agent, ['--cdp', app.base, 'tab', 'list', '--json'], { encoding: 'utf8', timeout: 20000 });
  assert.ok(listing.includes('127.0.0.1:' + fixture.port), 'agent-browser 未能看到内嵌页面');
  trace.push({ step: 'agent-browser 读取内嵌页面', value: JSON.parse(listing) });
  await ui.request('Runtime.evaluate', { expression: 'window.poc.flush()', awaitPromise: true, returnByValue: true });
  pageA.close(); pageB.close(); ui.close();
  await stopApp(app);
}

async function runRestart() {
  const port = await freePort();
  const app = await startApp(port, userData);
  const ui = connect(app.windowTarget.webSocketDebuggerUrl);
  await waitValue(ui, "document.querySelectorAll('#sessions button').length", value => value === 2);
  await openSession(ui, 'conv-a', fixtureUrl);
  const pageATarget = await findPage(app.base, fixtureUrl);
  const pageA = connect(pageATarget.webSocketDebuggerUrl);
  const cookieA = await waitValue(pageA, '({ready:document.readyState,cookie:document.cookie})', value => value && value.ready === 'complete' && value.cookie);
  assert.match(String(cookieA.cookie), /probe=A/, '重启后会话 A 的登录态应保留');
  await openSession(ui, 'conv-b', fixtureUrl);
  const pageB = connect((await findPage(app.base, fixtureUrl, pageATarget.id)).webSocketDebuggerUrl);
  const markerB = await waitValue(pageB, '({ready:document.readyState,cookie:document.cookie})', value => value && value.ready === 'complete');
  assert.equal(markerB.cookie, '', '重启后会话 B 仍不得读取 A 的 Cookie');
  trace.push({ step: '重启后持久化与隔离', value: { a: cookieA.cookie, b: markerB.cookie } });
  pageA.close(); pageB.close(); ui.close();
  await stopApp(app);
}

try {
  await runFirstLaunch();
  await runRestart();
  console.log(JSON.stringify({ passed: true, fixturePort: fixture.port, database, trace }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, error: String(error), trace }));
  process.exitCode = 1;
} finally {
  await fixture.close();
  process.exit(process.exitCode || 0);
}

