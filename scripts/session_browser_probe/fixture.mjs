import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

export async function startFixture(record, { port = 0 } = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture');
    record('fixture-http', { method: request.method, path: url.pathname });
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: '/red?marker=redirected' }).end();
      return;
    }
    if (url.pathname === '/download') { response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=browser-download.txt' }); response.end('browser-download-evidence'); return; }
    if (url.pathname === '/typing') {
      response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      response.end(`<!doctype html><title>原生输入验收</title><style>html,body{margin:0}textarea{position:fixed;inset:0;box-sizing:border-box;width:100vw;height:100vh;padding:24px;border:0;font:28px sans-serif}</style><textarea id="text" aria-label="输入验收" placeholder="点击此页，输入中文"></textarea><script>window.inputEvents=[];for(const type of ['keydown','keyup','input','paste','pointerdown','pointerup'])document.addEventListener(type,event=>{window.inputEvents.push({type,key:event.key,code:event.code,inputType:event.inputType,value:document.querySelector('#text').value});if(window.inputEvents.length>200)window.inputEvents.shift()})</script>`);
      return;
    }
    const blue = url.pathname === '/blue';
    const marker = url.searchParams.get('marker') || 'probe';
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end(`<!doctype html><html><head><title>${blue ? '蓝页' : '红页'}-${marker}</title></head>
<body style="margin:0;background:${blue ? '#1030e0' : '#e02010'};color:white;font:24px sans-serif">
<h1 id="marker">${marker}</h1><input id="text" style="width:500px;height:40px"><button id="click">提交</button>
<p id="result"></p><div id="tick"></div><p id="secret-marker">DOM-${randomUUID()}</p><input type="file" id="file"><div id="dropzone" style="width:500px;height:80px;border:2px dashed white">拖文件到这里</div><textarea id="paste" placeholder="粘贴图片到这里"></textarea><p id="upload-result"></p><a id="download" href="/download" download>下载测试文件</a><script>
window.received=null;
window.consume=file=>{const r=new FileReader();r.onload=()=>{window.received={name:file.name,size:file.size,type:file.type,data:r.result};document.querySelector('#upload-result').textContent='已接收 '+file.name+' '+file.size};r.readAsDataURL(file)};
document.querySelector('#file').onchange=e=>window.consume(e.target.files[0]);
document.querySelector('#dropzone').ondragover=e=>e.preventDefault();
document.querySelector('#dropzone').ondrop=e=>{e.preventDefault();window.consume(e.dataTransfer.files[0])};
document.querySelector('#paste').onpaste=e=>{if(e.clipboardData.files.length){e.preventDefault();window.consume(e.clipboardData.files[0])}};
window.probeReady=true; window.clicked=0; window.wsReply=null;
document.querySelector('#click').onclick=()=>{window.clicked++;document.querySelector('#result').textContent=document.querySelector('#text').value};
window.store=async(value)=>{document.cookie='probe='+value+'; max-age=86400; path=/';localStorage.setItem('probe',value);await new Promise((resolve,reject)=>{const r=indexedDB.open('probe',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onerror=reject;r.onsuccess=()=>{const tx=r.result.transaction('values','readwrite');tx.objectStore('values').put(value,'probe');tx.oncomplete=()=>{r.result.close();resolve()}}});return true};
window.readStore=async()=>({cookie:document.cookie,local:localStorage.getItem('probe'),idb:await new Promise((resolve,reject)=>{const r=indexedDB.open('probe',1);r.onerror=reject;r.onsuccess=()=>{const q=r.result.transaction('values').objectStore('values').get('probe');q.onsuccess=()=>{resolve(q.result??null);r.result.close()};q.onerror=reject}})});
const ws=new WebSocket('ws://'+location.host+'/hmr');ws.onopen=()=>ws.send('hmr:'+${JSON.stringify(marker)});ws.onmessage=e=>window.wsReply=e.data;
let tick=0;setInterval(()=>{document.querySelector('#tick').textContent='frame '+(++tick)},50);
</script></body></html>`);
  });
  // 此 fixture 只接自己生成的小型单帧 HMR 文本，不实现通用 WebSocket 服务。
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', frame => {
      if ((frame[0] & 15) !== 1 || (frame[1] & 127) > 125) return;
      const length = frame[1] & 127;
      const mask = frame.subarray(2, 6);
      const text = Buffer.from(frame.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4])).toString();
      record('fixture-ws', { text });
      const reply = Buffer.from('reply:' + text);
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
