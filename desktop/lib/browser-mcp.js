// 把面板内的原生 Chromium 页面以 session_browser 工具暴露给 Agent。
const http = require('node:http');
const { randomBytes } = require('node:crypto');

async function cdp(manager, conversationId, method, params) {
  const contents = manager.activeContents(conversationId);
  if (!contents) throw new Error('侧边浏览器尚未打开');
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  return contents.debugger.sendCommand(method, params);
}

async function evaluate(manager, conversationId, expression) {
  const reply = await cdp(manager, conversationId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error('页面脚本执行失败');
  return reply.result ? reply.result.value : undefined;
}

async function callTool(manager, conversationId, args) {
  if (!conversationId) throw new Error('请先打开该会话的侧边浏览器');
  manager.activateConversation(conversationId);
  const operation = args.operation;
  if (operation === 'list_pages' || operation === 'status') return manager.handle(conversationId, 'status');
  if (operation === 'navigate' || operation === 'open_page') return manager.handle(conversationId, 'navigate', { url: args.url });
  if (['close_page', 'select_page', 'activate_page'].includes(operation)) return manager.handle(conversationId, operation, args);
  if (operation === 'snapshot') {
    const text = await evaluate(manager, conversationId, 'document.body ? document.body.innerText.slice(0,20000) : ""');
    return { title: await evaluate(manager, conversationId, 'document.title'), text };
  }
  if (operation !== 'act') throw new Error('不支持的浏览器操作');
  const selector = JSON.stringify(args.selector || '');
  const action = args.action;
  if (['click', 'dblclick', 'focus', 'hover'].includes(action)) {
    const target = 'document.querySelector(' + selector + ')';
    const script = action === 'click' ? target + '?.click(), true'
      : action === 'focus' ? target + '?.focus(), true'
      : target + '?.dispatchEvent(new MouseEvent(' + JSON.stringify(action === 'hover' ? 'mouseover' : 'dblclick') + ',{bubbles:true})), true';
    await evaluate(manager, conversationId, script);
    return { acted: action };
  }
  if (['fill', 'type', 'select'].includes(action)) {
    const value = JSON.stringify(String(args.value ?? ''));
    const script = '(()=>{const e=document.querySelector(' + selector + ');if(!e)throw new Error("元素不存在");e.focus();e.value=' + value + ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()';
    await evaluate(manager, conversationId, script);
    return { filled: true };
  }
  if (action === 'get_text') return { text: await evaluate(manager, conversationId, 'document.querySelector(' + selector + ')?.textContent ?? null') };
  if (action === 'get_value') return { value: await evaluate(manager, conversationId, 'document.querySelector(' + selector + ')?.value ?? null') };
  if (action === 'evaluate') return { result: await evaluate(manager, conversationId, String(args.value ?? '')) };
  if (action === 'scroll') {
    const amount = Number(args.amount) || 500;
    const x = args.direction === 'left' ? -amount : args.direction === 'right' ? amount : 0;
    const y = args.direction === 'up' ? -amount : args.direction === 'down' ? amount : 0;
    await evaluate(manager, conversationId, 'window.scrollBy(' + x + ',' + y + '), true');
    return { scrolled: true };
  }
  if (['back', 'forward', 'reload'].includes(action)) return manager.handle(conversationId, action);
  throw new Error('不支持的页面操作');
}

function startBrowserMcp(manager, resolveConversation) {
  const token = randomBytes(16).toString('hex');
  const tool = {
    name: 'session_browser',
    description: '操作当前会话的侧边浏览器（与面板同一批原生页面）。',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list_pages', 'open_page', 'navigate', 'select_page', 'close_page', 'snapshot', 'act'] },
        target_id: { type: 'string' }, url: { type: 'string' }, action: { type: 'string' },
        selector: { type: 'string' }, value: { type: 'string' }, direction: { type: 'string' }, amount: { type: 'number' },
      },
      required: ['operation'], additionalProperties: false,
    },
  };
  const server = http.createServer(async (request, response) => {
    const incoming = new URL(request.url, 'http://127.0.0.1');
    if (incoming.pathname !== '/mcp/' + token) { response.writeHead(404).end(); return; }
    const taskId = incoming.searchParams.get('task');
    let body = '';
    for await (const chunk of request) body += chunk;
    let message;
    try { message = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    const handle = async () => {
      if (message.method === 'initialize') return { protocolVersion: message.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'akb-electron-browser', version: '0.1.0' } };
      if (message.method === 'ping') return {};
      if (message.method === 'tools/list') return { tools: [tool] };
      if (message.method === 'tools/call') {
        if (message.params?.name !== 'session_browser') throw new Error('未知工具');
        try {
          const conversationId = (await resolveConversation(taskId)) || manager.activeConversation;
          const value = await callTool(manager, conversationId, message.params.arguments || {});
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
        } catch (error) {
          return { content: [{ type: 'text', text: String(error.message || error) }], isError: true };
        }
      }
      throw new Error('未知 MCP 方法');
    };
    try {
      const result = await handle();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: String(error.message || error) } }));
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/mcp/' + token })));
}

module.exports = { evaluate, callTool, startBrowserMcp };
