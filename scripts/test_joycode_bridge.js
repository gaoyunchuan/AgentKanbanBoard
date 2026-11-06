const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { WebSocket } = require('../desktop/node_modules/ws');
const { startJoyCodeBridge } = require('../desktop/lib/joycode-bridge');

test('桥接器验证凭证、处理预热、通过 JSON/SSE 续接，并且不会转发 Codex 凭证', async t => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    if (request.method === 'GET') return response.writeHead(200).end();
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n');
    response.end('data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","role":"assistant","content":[]}]}}\n\n');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = await startJoyCodeBridge(async () => `http://127.0.0.1:${upstream.address().port}/v1`);
  t.after(() => { bridge.close(); upstream.close(); });
  const url = bridge.url.replace('http:', 'ws:') + '/responses';
  const denied = new WebSocket(url, { headers: { Authorization: 'Bearer unrelated' } });
  denied.on('error', () => {});
  assert.equal((await once(denied, 'unexpected-response'))[1].statusCode, 401);

  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + bridge.key } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const round = frame => new Promise((resolve, reject) => {
    const listener = data => {
      const event = JSON.parse(data);
      if (event.type === 'response.completed') { ws.off('message', listener); resolve(event); }
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ type: 'response.create', model: 'test', ...frame }), error => { if (error) reject(error); });
  });
  await round({ generate: false });
  assert.equal(received.length, 0);
  await round({ input: [{ type: 'message', role: 'user', content: 'first' }] });
  await round({ input: [{ type: 'message', role: 'user', content: 'second' }], previous_response_id: 'r1' });
  assert.equal(received[0].stream, true);
  assert.equal(received[0].type, undefined);
  assert.equal(received[1].previous_response_id, undefined);
  assert.equal(received[1].input.length, 3);
});

test('SSE 提前结束报告失败；关闭客户端会取消上游请求', { timeout: 5000 }, async t => {
  let aborted;
  const abortObserved = new Promise(resolve => { aborted = resolve; });
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"response.created"}\n\n');
    if (body.model === 'truncate') response.end();
    else response.on('close', aborted);
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = await startJoyCodeBridge(async () => `http://127.0.0.1:${upstream.address().port}/v1`);
  t.after(() => { bridge.close(); upstream.closeAllConnections(); upstream.close(); });
  const connect = async () => {
    const ws = new WebSocket(bridge.url.replace('http:', 'ws:') + '/responses', {
      headers: { Authorization: 'Bearer ' + bridge.key },
    });
    await once(ws, 'open');
    return ws;
  };
  const ws = await connect();
  const failure = new Promise(resolve => ws.on('message', data => {
    const event = JSON.parse(data);
    if (event.type === 'response.failed') resolve(event.response.error.message);
  }));
  ws.send(JSON.stringify({ type: 'response.create', model: 'truncate', input: [] }));
  assert.match(await failure, /响应流提前结束/);
  ws.terminate();
  const cancelled = await connect();
  cancelled.send(JSON.stringify({ type: 'response.create', model: 'pending', input: [] }));
  await once(cancelled, 'message');
  cancelled.terminate();
  await abortObserved;
});
