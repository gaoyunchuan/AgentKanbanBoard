// 隔离诊断真实产品分块上传；不改产品实现或共享 fixture。
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile, stat, link } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { startFixture } from './fixture.mjs';
import { withCdp } from '../session_browser_cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = `/tmp/akb-files-${randomUUID().slice(0, 8)}`;
const evidence = path.join(repo, 'docs/verification/2026-10-29-session-browser/probe/files');
await mkdir(root, { recursive: true });
await mkdir(evidence, { recursive: true });
const trace = [];
const record = (step, value) => { trace.push({ at: new Date().toISOString(), step, value }); console.log(step, JSON.stringify(value)); };
const fixture = await startFixture((step, value) => record(step, value));
const child = spawn(path.join(repo, 'src-tauri/target/debug/examples/session_browser_driver'), [path.join(root, 'app.db'), path.join(repo, '.build/browser/agent-browser'), path.join(repo, 'scripts')], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise(resolve => child.once('exit', resolve));
const pending = new Map(); let next = 1; let ready;
const initialized = new Promise(resolve => ready = resolve);
readline.createInterface({ input: child.stdout }).on('line', line => {
  const reply = JSON.parse(line);
  if (reply.ready) ready(reply);
  else if (pending.has(reply.id)) {
    const item = pending.get(reply.id); pending.delete(reply.id); clearTimeout(item.timer);
    reply.error ? item.reject(new Error(reply.error)) : item.resolve(reply.result);
  }
});
function call(owner, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = next++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}超时`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, owner, method, params }) + '\n');
  });
}
try {
  const { owners } = await initialized; const owner = owners[0].owner;
  await call(owner, 'status');
  await call(owner, 'navigate', { url: `http://host.docker.internal:${fixture.port}/blue?marker=files-diagnostic` });
  const state = await call(owner, 'status');
  const container = 'akb-' + createHash('sha256').update(state.state_path).digest('hex').slice(0, 24);
  record('state', { state, container, root });
  await call(owner, 'act', { action: 'evaluate', value: `window.fileDiagnostics=[];addEventListener('error',e=>fileDiagnostics.push({event:'error',message:e.message}));document.querySelector('#file').addEventListener('input',e=>fileDiagnostics.push({event:'input',length:e.target.files.length}));document.querySelector('#file').addEventListener('change',e=>{fileDiagnostics.push({event:'change',length:e.target.files.length});const f=e.target.files[0];if(f){fileDiagnostics.push({name:f.name,size:f.size,type:f.type});f.text().then(text=>fileDiagnostics.push({event:'text',text})).catch(error=>fileDiagnostics.push({event:'text-error',name:error.name,message:error.message}));const r=new FileReader;r.onerror=()=>fileDiagnostics.push({event:'reader-error',name:r.error?.name,message:r.error?.message});r.onload=()=>fileDiagnostics.push({event:'reader-load',result:r.result});r.readAsDataURL(f)}});true` });
  const payload = Buffer.from('浏览器文件诊断-' + randomUUID());
  await call(owner, 'upload_begin', { name: '剪贴板图片.png', size: payload.length });
  await call(owner, 'upload_chunk', { bytes: Array.from(payload) });
  const uploaded = await call(owner, 'upload_finish', { kind: 'input', target_id: state.target_id });
  record('uploaded', uploaded);
  const directory = path.join(state.state_path, 'downloads', '.uploads');
  const files = await readdir(directory);
  for (const file of files) {
    record('host-file', { file, stat: await stat(path.join(directory, file)), base64: (await readFile(path.join(directory, file))).toString('base64') });
    try { record('container-file', execFileSync('docker', ['exec', container, '/bin/sh', '-c', 'id; ls -ld /data/downloads /data/downloads/.uploads; ls -l /data/downloads/.uploads'], { encoding: 'utf8' })); } catch (error) { record('container-file-error', error.message); }
  }
  const diagnostics = await call(owner, 'act', { action: 'evaluate', value: `new Promise(resolve=>setTimeout(()=>resolve({received:window.received,diagnostics:window.fileDiagnostics,files:[...document.querySelector('#file').files].map(f=>({name:f.name,size:f.size,type:f.type})),handler:String(document.querySelector('#file').onchange)}),1000))` });
  record('diagnostics', diagnostics);
  record('console', await call(owner, 'act', { action: 'console' }));
  record('errors', await call(owner, 'act', { action: 'errors' }));
  const port = execFileSync('docker', ['port', container, '9222/tcp'], { encoding: 'utf8' }).trim();
  const endpoint = `http://${port}`;
  const targets = await (await fetch(endpoint + '/json/list')).json();
  const target = targets.find(item => item.id === state.target_id);
  const pageSocket = 'ws://' + new URL(endpoint).host + new URL(target.webSocketDebuggerUrl).pathname;
  const filename = '/data/downloads/.uploads/' + files[0];
  await withCdp(pageSocket, async request => {
    const element = await request('Runtime.evaluate', { expression: 'document.querySelector("#file")', returnByValue: false });
    record('raw-object', element);
    record('raw-object-set', await request('DOM.setFileInputFiles', { files: [filename], objectId: element.result.objectId }));
    record('raw-object-value', await request('Runtime.evaluate', { expression: '({files:[...document.querySelector("#file").files].map(f=>({name:f.name,size:f.size})),diagnostics:window.fileDiagnostics,received:window.received})', returnByValue: true }));
    await request('DOM.enable');
    record('dom-enable-set', await request('DOM.setFileInputFiles', { files: [filename], objectId: element.result.objectId }));
    record('dom-enable-value', await request('Runtime.evaluate', { expression: '({files:[...document.querySelector("#file").files].map(f=>({name:f.name,size:f.size})),diagnostics:window.fileDiagnostics,received:window.received})', returnByValue: true }));
    const described = await request('DOM.describeNode', { objectId: element.result.objectId });
    record('described', described);
    record('backend-set', await request('DOM.setFileInputFiles', { files: [filename], backendNodeId: described.node.backendNodeId }));
    record('backend-value', await request('Runtime.evaluate', { expression: '({files:[...document.querySelector("#file").files].map(f=>({name:f.name,size:f.size})),diagnostics:window.fileDiagnostics,received:window.received})', returnByValue: true }));
    await link(path.join(directory, files[0]), path.join(directory, 'diagnostic.txt'));
    record('ascii-set', await request('DOM.setFileInputFiles', { files: ['/data/downloads/.uploads/diagnostic.txt'], objectId: element.result.objectId }));
    record('ascii-value', await request('Runtime.evaluate', { expression: '({files:[...document.querySelector("#file").files].map(f=>({name:f.name,size:f.size})),diagnostics:window.fileDiagnostics,received:window.received})', returnByValue: true }));
  });
} catch (error) { record('failure', error.stack); process.exitCode = 1; }
finally {
  child.stdin.end(); await exited; await fixture.close();
  await writeFile(path.join(evidence, 'trace.json'), JSON.stringify(trace, null, 2));
  record('cleanup', { containers: execFileSync('docker', ['ps', '-a', '--filter', `label=local.codex.kanban.browser=true`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim() });
  await writeFile(path.join(evidence, 'trace.json'), JSON.stringify(trace, null, 2));
}
