// JoyCode 管理公司登录与模型路由；本桥接只翻译 Codex 的 WebSocket 传输。
const { execFile } = require('node:child_process');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createServer } = require('node:http');
const { promisify } = require('node:util');
const { WebSocketServer } = require('ws');

const run = promisify(execFile);
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_EVENT = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 8;
const TIMEOUT = 180_000;
const ROUTE = '/api/saas/openai/v1';

async function discoverJoyCode() {
  const { stdout } = await run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,args='], {
    timeout: 3000, maxBuffer: 4 * 1024 * 1024,
  });
  const processes = stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/));
  for (const item of processes) {
    if (!item) continue;
    const [, , parent, args] = item;
    if (!args.startsWith('/Applications/JoyCode.app/Contents/Resources/sidecar/codex-app-server ')) continue;
    if (!processes.some(row => row?.[1] === parent && /^(JoyCode(?: |$)|\/Applications\/JoyCode\.app\/Contents\/MacOS\/JoyCode(?: |$))/.test(row[3]))) continue;
    const port = args.match(/\bbase_url="http:\/\/127\.0\.0\.1:(\d{1,5})\/api\/saas\/openai\/v1"/)?.[1];
    if (!port || Number(port) > 65535 || Number(port) === 0) continue;
    try {
      const { stdout: listeners } = await run('/usr/sbin/lsof', [
        '-nP', '-a', '-p', parent, '-iTCP:' + port, '-sTCP:LISTEN', '-Fn',
      ], { timeout: 3000, maxBuffer: 64 * 1024 });
      if (listeners.split('\n').includes('n127.0.0.1:' + port)) return 'http://127.0.0.1:' + port + ROUTE;
    } catch { /* 进程可能刚退出；继续检查其他实例。 */ }
  }
  throw new Error('未找到 JoyCode 代理，请打开并登录 JoyCode 桌面版');
}

function sendEvent(socket, event) {
  if (socket.readyState !== 1 || socket.bufferedAmount > MAX_EVENT) {
    socket.terminate();
    throw new Error('模型连接已关闭或接收过慢');
  }
  socket.send(JSON.stringify(event));
}

function warmup(socket, model) {
  const response = { id: '', object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [] };
  sendEvent(socket, { type: 'response.created', sequence_number: 0, response: { ...response, status: 'in_progress' } });
  sendEvent(socket, { type: 'response.completed', sequence_number: 1, response: { ...response, status: 'completed' } });
}

function requestBody(frame, previous) {
  const { type, generate, previous_response_id: id, ...body } = frame;
  if (type !== 'response.create' || !Array.isArray(body.input)) throw new Error('无法读取模型请求');
  if (id) {
    // Codex 可能只发送增量；JoyCode 不依赖上游保留 response ID。
    if (previous?.id !== id) throw new Error('模型上下文已断开，请重新发送本轮消息');
    body.input = [...previous.input, ...previous.output, ...body.input];
  }
  const payload = JSON.stringify({ ...body, stream: true });
  if (Buffer.byteLength(payload) > MAX_FRAME) throw new Error('模型请求超过 16 MiB');
  return { payload, input: body.input };
}

async function* readEvents(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const split = buffer.match(/\r?\n\r?\n/);
      if (!split) break;
      if (split.index > MAX_EVENT) throw new Error('模型事件过大');
      const frame = buffer.slice(0, split.index);
      buffer = buffer.slice(split.index + split[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > MAX_EVENT) throw new Error('模型事件过大');
  }
}

async function relay(socket, frame, previous, discover, signal) {
  const { payload, input } = requestBody(frame, previous);
  const base = await discover();
  const upstream = await fetch(base + '/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: payload, signal, redirect: 'error',
  });
  if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
    await upstream.body?.cancel();
    throw new Error(`JoyCode 请求失败（HTTP ${upstream.status}），请检查 JoyCode 登录及连接`);
  }
  for await (const event of readEvents(upstream.body)) {
    sendEvent(socket, event);
    if (event.type === 'response.completed') {
      const { id, output } = event.response || {};
      return typeof id === 'string' && Array.isArray(output) &&
        Buffer.byteLength(JSON.stringify({ input, output })) <= MAX_FRAME ? { id, input, output } : null;
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) return null;
  }
  throw new Error('JoyCode 响应流提前结束，请检查后重试');
}

function attachSocket(socket, discover) {
  let active;
  let previous;
  socket.on('error', () => socket.terminate());
  socket.on('close', () => { active?.abort(); previous = null; });
  socket.on('message', async (data, binary) => {
    if (active || binary) { socket.close(1008, '不支持并发或二进制请求'); return; }
    const request = new AbortController();
    active = request;
    try {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'response.create' && frame.generate === false) { warmup(socket, frame.model); return; }
      previous = await relay(socket, frame, previous, discover,
        AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT)]));
    } catch (error) {
      previous = null;
      // 以显式终止事件结束，避免客户端把不确定回合当作可安全重连。
      if (socket.readyState === 1) {
        try { sendEvent(socket, { type: 'response.failed', response: { status: 'failed',
          error: { code: 'joycode_bridge_error', message: error instanceof SyntaxError ? 'JoyCode 响应格式无效' : error.message } } }); }
        catch { socket.terminate(); }
      }
    } finally { active = undefined; }
  });
}

async function startJoyCodeBridge(discover = discoverJoyCode) {
  const key = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + key);
  const authorized = request => {
    const actual = Buffer.from(request.headers.authorization || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/v1/health' || !authorized(request)) {
      response.writeHead(404).end(); return;
    }
    try {
      const upstream = await fetch(await discover() + '/models', { signal: AbortSignal.timeout(6000), redirect: 'error' });
      await upstream.body?.cancel();
      response.writeHead(upstream.ok ? 204 : 503).end();
    } catch { response.writeHead(503).end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (request.url !== '/v1/responses' || wss.clients.size >= MAX_CONNECTIONS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => attachSocket(ws, discover));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { key, url: 'http://127.0.0.1:' + server.address().port + '/v1', close() {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  } };
}

module.exports = { startJoyCodeBridge, discoverJoyCode };
