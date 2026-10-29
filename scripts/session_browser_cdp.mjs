// 上游stream不承担本机文件桥；仅在已绑定的同一Chrome上补齐下载/文件输入配置。
async function openCdp(url) {
  const socket = new WebSocket(url), pending = new Map(); let id = 0;
  const handshake = setTimeout(() => socket.close(), 10000);
  socket.onmessage = event => {
    let reply; try { reply = JSON.parse(String(event.data)); } catch { return; }
    const task = pending.get(reply.id);
    if (task) { pending.delete(reply.id); clearTimeout(task.timer); reply.error ? task.reject(new Error(reply.error.message)) : task.resolve(reply.result); }
  };
  socket.onclose = () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('浏览器配置连接已关闭')); } pending.clear(); };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('无法连接会话浏览器'));
    socket.addEventListener('close', () => reject(new Error('浏览器配置连接已关闭')), { once: true });
  }).finally(() => clearTimeout(handshake));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN || pending.size >= 16) { reject(new Error('浏览器配置连接不可用')); return; }
    const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(new Error('浏览器配置操作超时')); }, 10000);
    pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params }));
  });
  return { request, close: () => socket.close() };
}
export async function withCdp(url, operation) {
  const connection = await openCdp(url);
  try { return await operation(connection.request); } finally { connection.close(); }
}

export async function configureDownloads(endpoint) {
  // Chromium将下载策略绑定到这条CDP连接，不能配置完就断开，否则界面点击下载会静默失效。
  const connection = await openCdp(endpoint);
  try { await connection.request('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/data/downloads', eventsEnabled: true }); return connection; }
  catch (error) { connection.close(); throw error; }
}
export async function uploadToPage(endpoint, target, filename, selector = 'input[type=file]', kind = 'input', coordinates = {}) {
  if (!filename.startsWith('/data/downloads/.uploads/') || filename.split('/').includes('..')) throw new Error('无效的本会话上传文件');
  const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(3000) });
  const page = (await response.json()).find(p => p.type === 'page' && p.id === target);
  if (!page) throw new Error('上传目标已关闭');
  const base = new URL(endpoint), advertised = new URL(page.webSocketDebuggerUrl);
  const socket = `ws://${base.host}${advertised.pathname}`;
  return withCdp(socket, async request => {
    if (kind === 'drop') {
      const x = Math.max(0, Math.min(1600, Number(coordinates.x))), y = Math.max(0, Math.min(1200, Number(coordinates.y)));
      if (!Number.isFinite(x + y)) throw new Error('文件拖入位置无效');
      const data = { items: [], files: [filename], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop']) await request('Input.dispatchDragEvent', { type, x, y, data });
      return { uploaded: true };
    }
    if (kind === 'paste') {
      const created = await request('Runtime.evaluate', { expression: "(()=>{const e=document.createElement('input');e.type='file';e.hidden=true;document.body.append(e);return e})()", returnByValue: false });
      const objectId = created.result?.objectId;
      if (!objectId) throw new Error('当前网页不能接收图片');
      try {
        await request('DOM.setFileInputFiles', { files: [filename], objectId });
        const outcome = await request('Runtime.callFunctionOn', { objectId, functionDeclaration: "function(){const data=new DataTransfer();data.items.add(this.files[0]);const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});return !(document.activeElement||document.body).dispatchEvent(event)}", returnByValue: true });
        if (outcome.exceptionDetails || !outcome.result?.value) throw new Error('当前网页未接收图片粘贴，请使用上传文件');
        return { uploaded: true };
      } finally { await request('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){this.remove()}' }).catch(() => {}); }
    }
    const evaluated = await request('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
    if (!evaluated.result?.objectId || evaluated.result.subtype === 'null') throw new Error('当前页面没有文件上传控件，请先打开需要上传文件的页面');
    await request('DOM.setFileInputFiles', { files: [filename], objectId: evaluated.result.objectId });
    return { uploaded: true };
  });
}

export async function insertTextIntoFocused(endpoint, target, text) {
  // CDP的char事件只接受单个字符；整段粘贴走页面的insertText，保留一次input事件语义。
  if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > 16384) throw new Error('粘贴文本为空或超过16KiB');
  const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(3000) });
  const page = (await response.json()).find(p => p.type === 'page' && p.id === target);
  if (!page) throw new Error('插入目标已关闭');
  const base = new URL(endpoint), advertised = new URL(page.webSocketDebuggerUrl);
  return withCdp(`ws://${base.host}${advertised.pathname}`, async request => {
    const focused = await request('Runtime.evaluate', { expression: "(()=>{const e=document.activeElement;return !!e&&('value' in e||e.isContentEditable)})()", returnByValue: true });
    if (focused.result?.value !== true) throw new Error('请先点击网页中的输入位置，再粘贴文本');
    const outcome = await request('Runtime.evaluate', { expression: `(()=>{try{return document.execCommand('insertText',false,${JSON.stringify(text)})}catch{return false}})()`, returnByValue: true });
    if (outcome.exceptionDetails || outcome.result?.value !== true) throw new Error('当前网页未接收粘贴文本，请点击输入框后重试');
    return { inserted: true };
  });
}

// 直接使用Chrome的页面级CDP：恢复时并行建页与导航，不等待加载完成。
export async function createBlankPage(endpoint) {
  const response = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Docker Chrome拒绝创建页面');
  return response.json();
}

export async function navigateTargetWithoutWaiting(endpoint, target, url) {
  const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(3000) });
  const page = (await response.json()).find(p => p.type === 'page' && p.id === target);
  if (!page) throw new Error('恢复目标已关闭');
  const base = new URL(endpoint), advertised = new URL(page.webSocketDebuggerUrl);
  return withCdp(`ws://${base.host}${advertised.pathname}`, request => request('Page.navigate', { url }));
}
