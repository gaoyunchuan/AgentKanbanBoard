// 本地 TCP 故意保留半关闭连接，复现 Rust 广播 writer 克隆的生命周期。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(reply, timeout = 120000, publishPort = true) {
  const peers = new Set(), clients = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      reply(socket, request);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
  const root = path.resolve(__dirname, '../desktop');
  const localRequire = createRequire(path.join(root, 'main.js'));
  const module = { exports: {} };
  const context = { module, __dirname: root, process, console, Buffer, setTimeout: (fn, ms) => setTimeout(fn, ms === 120000 ? timeout : ms), clearTimeout,
    require(name) {
      if (name === 'electron') return { app: { commandLine: { appendSwitch() {} } } };
      if (name === 'node:child_process') return { spawn: () => child };
      if (name === 'node:fs') return { existsSync: () => true };
      if (name === 'node:net') return { createConnection(...args) { const socket = net.createConnection(...args); clients.add(socket); socket.on('close', () => clients.delete(socket)); return socket; } };
      return localRequire(name);
    } };
  const source = fs.readFileSync(process.env.AKB_SIDECAR_TEST_SOURCE || path.join(root, 'main.js'), 'utf8').split('app.whenReady()')[0];
  vm.runInNewContext(source + '\nmodule.exports = { startSidecar };', context);
  const backend = module.exports.startSidecar('');
  if (publishPort) child.stdout.write(JSON.stringify({ sidecar: server.address().port }) + '\n');
  return { backend, peers, clients, child, async close() {
    backend.dispose?.(); child.emit('exit', 0); child.stdout.destroy();
    for (const socket of clients) socket.destroy();
    for (const socket of peers) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

test('重复读取会话后立即释放连接，不保留历史响应和半关闭 TCP', async () => {
  const f = await fixture((socket, request) => socket.write(JSON.stringify({ id: request.id, result: { text: '文'.repeat(40000) } }) + '\n'));
  try {
    for (let i = 0; i < 40; i++) assert.equal((await f.backend.call('chat_command', { method: 'detail' })).text.length, 40000);
    await delay(50);
    assert.equal(f.clients.size, 0, '每个一次性 RPC 必须主动销毁 socket，不能等半关闭的服务端发送 FIN');
  } finally { await f.close(); }
});

test('协议错误、提前断流、损坏响应和超时均清理连接', async () => {
  for (const mode of ['error', 'end', 'invalid', 'timeout']) {
    const f = await fixture((socket, request) => {
      if (mode === 'error') socket.write(JSON.stringify({ id: request.id, error: '服务端拒绝' }) + '\n');
      if (mode === 'end') socket.end('{"id":');
      if (mode === 'invalid') socket.write('invalid-json\n');
    }, 40);
    try {
      await assert.rejects(f.backend.call('check'), /拒绝|提前结束|格式无效|超时/);
      await delay(20); assert.equal(f.clients.size, 0, mode);
    } finally { await f.close(); }
  }
});

test('在途 RPC 达到上限时背压，后端退出清理所有等待且不自动重放', async () => {
  const f = await fixture(() => {});
  try {
    const calls = Array.from({ length: 16 }, () => f.backend.call('check'));
    const results = Promise.allSettled(calls);
    await assert.rejects(f.backend.call('overflow'), /请求较多/);
    await delay(20); assert.equal(f.clients.size, 16);
    f.child.emit('exit', 1);
    assert.ok((await results).every(r => r.status === 'rejected' && /已退出/.test(r.reason.message)));
    await assert.rejects(f.backend.call('after-exit'), /已退出/);
    await delay(20); assert.equal(f.clients.size, 0);
  } finally { await f.close(); }
});

test('超量响应主动失败，响应分块和通知不能导致错误归属', async () => {
  const f = await fixture((socket, request) => {
    if (request.method === 'large') { socket.write('x'.repeat(33 * 1024 * 1024)); return; }
    socket.write(JSON.stringify({ event: 'workbench/changed' }) + '\n');
    socket.write('{"id":' + request.id + ',"res');
    socket.write('ult":{"value":"中文"}}\n');
  });
  try {
    assert.equal((await f.backend.call('normal')).value, '中文');
    await assert.rejects(f.backend.call('large'), /32 MiB/);
    await delay(20); assert.equal(f.clients.size, 0);
  } finally { await f.close(); }
});

test('连续读取大段会话后内存保持稳定', { skip: !global.gc }, async () => {
  const f = await fixture((socket, request) => socket.write(JSON.stringify({ id: request.id, result: { text: '文'.repeat(250000) } }) + '\n'));
  const samples = [];
  try {
    global.gc(); const baseline = process.memoryUsage().heapUsed;
    for (let i = 1; i <= 160; i++) {
      await f.backend.call('chat_command', { method: 'detail' });
      if (i % 40 === 0) {
        await delay(20); global.gc();
        samples.push({ calls: i, heapBytes: process.memoryUsage().heapUsed, openClients: f.clients.size });
      }
    }
    console.log('sidecar-memory-samples', JSON.stringify({ baseline, samples }));
    assert.ok(samples.at(-1).heapBytes - baseline < 12 * 1024 * 1024, '大响应不能被已完成请求的 socket/Promise 继续保留');
  } finally { await f.close(); }
});

test('端口就绪前启动失败会结清已有及后续请求', async () => {
  const f = await fixture(() => {}, 120000, false);
  try {
    const attempt = f.backend.call('before-ready').catch(error => error.message);
    f.child.emit('error', new Error('spawn EACCES'));
    const result = await Promise.race([attempt, delay(80).then(() => 'still pending')]);
    assert.match(result, /spawn EACCES/);
    await assert.rejects(f.backend.call('after-error'), /spawn EACCES/);
    assert.equal(f.clients.size, 0);
  } finally { await f.close(); }
});
