// 真实产品桥接验收；外部fixture可控，内部Rust/sidecar/Docker链路不mock。
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { startFixture } from './session_browser_probe/fixture.mjs';
import { dockerLaunchArgs } from './session_browser_core.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const root = process.env.AKB_BROWSER_E2E_ROOT || `/tmp/akb-browser-product-${randomUUID().slice(0,8)}`;
const evidence = path.join(repo, 'docs/verification/2026-10-29-session-browser/product');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true });
let passed = false;
const trace = [];
const record = (step, value) => { trace.push({ at: new Date().toISOString(), step, value }); };
const fixture = await startFixture((step, value) => record(step, value));
const realDocker = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
const dockerFaultFile = path.join(root, 'docker-fault.json');
const dockerWrapper = path.join(root, 'docker-test-wrapper');
// 仅对指定测试容器注入一次stop/rm失败；其他命令直接执行真实Docker，不接触其他会话。
await writeFile(dockerWrapper, `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const args=process.argv.slice(2);const filename=${JSON.stringify(dockerFaultFile)};if(fs.existsSync(filename)){const fault=JSON.parse(fs.readFileSync(filename));if(args[0]===fault.method&&args.at(-1)===fault.name){fs.unlinkSync(filename);console.error('fixture Docker '+fault.method+'暂时失败');process.exit(42)}}const child=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});process.exit(child.status??1);\n`, { mode: 0o700 });
const child = spawn(path.join(repo, 'src-tauri/target/debug/examples/session_browser_driver'), [path.join(root,'app.db'), path.join(repo,'.build/browser/agent-browser'),path.join(repo,'scripts')], {stdio:['pipe','pipe','inherit'],env:{...process.env,AKB_DOCKER_PATH:dockerWrapper}});
const exited = new Promise(resolve => child.once('exit',resolve));
const pending = new Map(); let next = 1, ready;
const initialized = new Promise(resolve => { ready = resolve; });
const replies = readline.createInterface({input:child.stdout});
replies.on('line', line => {
  const result = JSON.parse(line);
  if (result.ready) ready(result);
  else if (pending.has(result.id)) { const item = pending.get(result.id); pending.delete(result.id); clearTimeout(item.timer); result.error ? item.reject(new Error(result.error)) : item.resolve(result.result); }
});
function call(owner, method, params={}) {
  return new Promise((resolve,reject)=>{
    const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}超时`));},90000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,owner,method,params})+'\n');
  });
}
async function mcp(url, method, params={}) {
  const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:next++,method,params}),signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);return (await response.json()).result;
}
async function assertFailedManifestIsPreserved(owner, state, aUrl, bUrl, expectedStorage) {
  let available = false;
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    // 真正的导航超时，而非Chrome可当作成功文档的错误页。
    if (!available) return;
    response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    response.end('<!doctype html><title>恢复重试正常页</title><p>恢复重试成功</p>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temporaryUrl = `http://host.docker.internal:${server.address().port}/recover`;
  const filename = path.join(state.state_path, 'pages.json');
  try {
    await call(owner, 'stop');
    const rejected = JSON.stringify({ version: 1, pages: [{ title: '第一页', url: aUrl }, { title: '不可恢复旧地址', url: 'file:///unrestorable-legacy-page' }, { title: '末页', url: bUrl }], active_index: 2 }, null, 3) + '\n';
    await writeFile(filename, rejected);
    const name = 'akb-' + createHash('sha256').update(state.state_path).digest('hex').slice(0, 24);
    await writeFile(dockerFaultFile, JSON.stringify({ method: 'stop', name }));
    await assert.rejects(call(owner, 'status'), /HTTP|地址|恢复/);
    assert.equal(await readFile(filename, 'utf8'), rejected, '恢复参数失败覆盖了原始完整页面清单');
    const incomplete = JSON.parse(execFileSync(realDocker, ['inspect', name], { encoding: 'utf8' }))[0];
    assert.equal(incomplete.State.Running, true, '故障注入没有保留待清理容器');
    const recoveredCleanup = await call(owner, 'stop');
    assert.equal(recoveredCleanup.stopped, true);
    assert.equal(execFileSync(realDocker, ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim(), '');
    assert.equal(await readFile(filename, 'utf8'), rejected);
    record('启动恢复失败且Docker停止失败保留槽并stop-only恢复', { name, recoveredCleanup, originalBytes: Buffer.byteLength(rejected) });
    const original = JSON.stringify({ version: 1, pages: [{ title: '第一页', url: aUrl }, { title: '中间离线页', url: temporaryUrl }, { title: '末页', url: bUrl }], active_index: 2 }, null, 3) + '\n';
    await writeFile(filename, original);
    await assert.rejects(call(owner, 'status'), /浏览器|页面|导航|错误|失败|error/i);
    assert.equal(await readFile(filename, 'utf8'), original, '恢复中途失败覆盖了原始完整页面清单');
    available = true;
    const retried = await call(owner, 'status');
    assert.deepEqual(retried.pages.map(page => page.url), [aUrl, temporaryUrl, bUrl]);
    assert.equal(retried.pages.find(page => page.active).url, bUrl);
    const storage = await call(owner, 'act', { action: 'evaluate', value: 'window.readStore()' });
    assert.deepEqual(storage.result, expectedStorage);
    record('中途恢复失败保留完整清单且可重试', { filename, originalBytes: Buffer.byteLength(original), pages: retried.pages, storage: storage.result });
    await call(owner, 'close_page', { target_id: retried.pages.find(page => page.url === temporaryUrl).id });
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
}
async function assertBlobPopupRestoration(owner, bUrl, expectedStorage) {
  const created = await call(owner, 'act', { action: 'evaluate', value: '(()=>{const url=URL.createObjectURL(new Blob(["<!doctype html><title>临时报表</title><p>临时内容</p><script>window.blobReplayed=true<\\/script>"],{type:"text/html"}));const popup=window.open(url,"_blank");return {url,opened:!!popup}})()' });
  assert.equal(created.result.opened, true);
  const deadline = Date.now() + 5000; let popup;
  while (!popup) {
    popup = (await call(owner, 'list_pages')).pages.find(page => page.url === created.result.url);
    if (!popup && Date.now() > deadline) throw new Error('真实Blob弹窗未进入页面列表');
  }
  await call(owner, 'select_page', { target_id: popup.id });
  await call(owner, 'stop');
  const restored = await call(owner, 'status');
  const placeholder = restored.pages.find(page => page.active);
  assert.equal(placeholder.url, 'about:blank');
  assert.ok(placeholder.title.includes('临时页面未恢复'));
  const body = await call(owner, 'act', { action: 'evaluate', value: '({text:document.body.textContent,replayed:window.blobReplayed===true})' });
  assert.ok(body.result.text.includes('重新打开'));
  assert.equal(body.result.replayed, false);
  assert.ok(restored.pages.some(page => page.url === bUrl));
  await call(owner, 'select_page', { target_id: restored.pages.find(page => page.url === bUrl).id });
  const storage = await call(owner, 'act', { action: 'evaluate', value: 'window.readStore()' });
  assert.deepEqual(storage.result, expectedStorage);
  record('真实Blob弹窗重启以说明页占位且正常页登录保留', { originalBlobUrl: created.result.url, pages: restored.pages, placeholder: body.result, storage: storage.result });
}
async function assertCleanupRetry(owner, expectedStorage) {
  for (const method of ['stop', 'rm']) {
    const state = await call(owner, 'status');
    const name = 'akb-' + createHash('sha256').update(state.state_path).digest('hex').slice(0, 24);
    await writeFile(dockerFaultFile, JSON.stringify({ method, name }));
    await assert.rejects(call(owner, 'stop'), /fixture Docker|退出码42/);
    const failed = JSON.parse(execFileSync(realDocker, ['inspect', name], { encoding: 'utf8' }))[0];
    assert.equal(failed.State.Running, method === 'stop');
    const stopped = await call(owner, 'stop');
    assert.equal(stopped.stopped, true);
    assert.equal(execFileSync(realDocker, ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim(), '');
    const reopened = await call(owner, 'status');
    const storage = await call(owner, 'act', { action: 'evaluate', value: 'window.readStore()' });
    assert.deepEqual(storage.result, expectedStorage);
    record('真实关闭失败可重试-' + method, { name, firstFailureRunning: failed.State.Running, stopped, pages: reopened.pages, storage: storage.result });
  }
}
async function assertStopOnlyRecovery(owner) {
  const state = await call(owner, 'status');
  await call(owner, 'stop');
  const namespace = createHash('sha256').update(state.state_path).digest('hex').slice(0, 24), name = 'akb-' + namespace;
  const runtime = JSON.parse(await readFile(path.join(repo, 'scripts/session_browser_probe/runtime.json'), 'utf8'));
  execFileSync(realDocker, dockerLaunchArgs({ name, namespace, profile: path.join(state.state_path, 'profile'), downloads: path.join(state.state_path, 'downloads'), image: runtime.chrome.platforms[process.arch === 'arm64' ? 'arm64' : 'amd64'].configId, uid: process.getuid(), gid: process.getgid() }));
  const env = { ...process.env, AKB_BROWSER_OWNER_DIR: state.state_path, AKB_AGENT_BROWSER_PATH: '/missing-agent-browser', AKB_DOCKER_PATH: dockerWrapper };
  try {
    await writeFile(dockerFaultFile, JSON.stringify({ method: 'stop', name }));
    let failed;
    try { execFileSync(process.execPath, [path.join(repo, 'scripts/session_browser.mjs'), '--stop-only'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { failed = error; }
    assert.equal(failed?.status, 1);
    assert.ok(!String(failed.stdout).includes('"cleanup_complete":true'));
    const first = JSON.parse(execFileSync(realDocker, ['inspect', name], { encoding: 'utf8' }))[0];
    assert.equal(first.State.Running, true);
    const output = execFileSync(process.execPath, [path.join(repo, 'scripts/session_browser.mjs'), '--stop-only'], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(output).cleanup_complete, true);
    assert.equal(execFileSync(realDocker, ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim(), '');
    assert.equal(JSON.parse(execFileSync(process.execPath, [path.join(repo, 'scripts/session_browser.mjs'), '--stop-only'], { env, encoding: 'utf8' })).cleanup_complete, true);
    record('stop-only不依赖Agent且可恢复未知归属状态', { name, output: JSON.parse(output), firstFailureRunning: first.State.Running });
  } finally {
    await unlink(dockerFaultFile).catch(() => {});
    if (execFileSync(realDocker, ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { encoding: 'utf8' }).trim()) {
      execFileSync(realDocker, ['stop', name]); execFileSync(realDocker, ['rm', name]);
    }
  }
  return call(owner, 'status');
}
async function assertLargeManifestFromFile(owner, state, aUrl, bUrl, expectedStorage) {
  await call(owner, 'stop');
  const filename = path.join(state.state_path, 'pages.json');
  const manifest = JSON.stringify({ version: 1, pages: [{ title: '正常第一页', url: aUrl }, { title: '临时大文档', url: 'data:text/html,' + 'x'.repeat(140000) }, { title: '正常末页', url: bUrl }], active_index: 2 });
  assert.ok(Buffer.byteLength(manifest) > 128 * 1024);
  await writeFile(filename, manifest);
  const restored = await call(owner, 'status');
  assert.equal(restored.pages.length, 3);
  assert.ok(restored.pages.some(page => page.url === 'about:blank' && page.title.includes('临时页面未恢复')));
  assert.equal(restored.pages.find(page => page.active).url, bUrl);
  const storage = await call(owner, 'act', { action: 'evaluate', value: 'window.readStore()' });
  assert.deepEqual(storage.result, expectedStorage);
  record('超过128KiB清单从文件恢复且不重放data内容', { filename, bytes: Buffer.byteLength(manifest), pages: restored.pages, storage: storage.result });
}
try {
  const {owners}=await initialized, A=owners[0].owner,B=owners[1].owner;
  const marker='saved-'+randomUUID(),aUrl=`http://host.docker.internal:${fixture.port}/red?marker=${marker}`,bUrl=`http://host.docker.internal:${fixture.port}/blue?marker=${marker}`;
  const a=await call(A,'status'); assert.ok(a.stream_url.startsWith('ws://127.0.0.1:')); record('A启动', {state_path:a.state_path,pages:a.pages});
  await call(A,'navigate',{url:aUrl}); await call(A,'act',{action:'evaluate',value:`window.store(${JSON.stringify(marker)})`});
  await call(A,'open_page',{url:bUrl}); const before=await call(A,'act',{action:'evaluate',value:'window.readStore()'});
  assert.deepEqual(before.result,{cookie:`probe=${marker}`,idb:marker,local:marker}); record('保存网页状态',before);
  const cfg=await call(A,'mcp_config');const init=await mcp(cfg.url,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'product-e2e',version:'1'}});assert.ok(init.serverInfo);
  const tools=await mcp(cfg.url,'tools/list');assert.ok(tools.tools.some(x=>x.name==='session_browser'));
  const domText=await call(A,'act',{action:'get_text',selector:'#secret-marker'});const domMarker=JSON.stringify(domText).match(/DOM-[a-f0-9-]+/)?.[0];assert.ok(domMarker);
  const snap=await mcp(cfg.url,'tools/call',{name:'session_browser',arguments:{operation:'snapshot'}});assert.ok(!snap.isError);assert.ok(JSON.stringify(snap).includes(domMarker),'MCP快照遗漏页面正文独有标记');
  const scoped=await mcp(cfg.url,'tools/call',{name:'session_browser',arguments:{operation:'snapshot',selector:'#secret-marker'}});assert.ok(!scoped.isError);assert.ok(JSON.stringify(scoped).includes(domMarker));record('真实MCP读取', {domMarker,structured:snap.structuredContent,content:snap.content,scoped});
  const blocked=await mcp(cfg.url,'tools/call',{name:'session_browser',arguments:{operation:'act',action:'fill',selector:'#text',value:'Agent'}});assert.equal(blocked.isError,true);
  await call(A,'release_control');
  const filled=await mcp(cfg.url,'tools/call',{name:'session_browser',arguments:{operation:'act',action:'fill',selector:'#text',value:'--cdp http://evil'}});assert.ok(!filled.isError);
  const value=await call(A,'act',{action:'get_value',selector:'#text'});assert.ok(JSON.stringify(value).includes('--cdp http://evil'));record('Agent变更与输入边界',value);
  await call(B,'status');await call(B,'navigate',{url:aUrl});const isolated=await call(B,'act',{action:'evaluate',value:'({cookie:document.cookie,local:localStorage.getItem("probe")})'});assert.deepEqual(isolated.result,{cookie:'',local:null});
  const stateA=await call(A,'status');await assert.rejects(call(B,'select_page',{target_id:stateA.target_id}));record('A/B隔离',isolated);
  await call(A,'stop'); const restored=await call(A,'status');assert.equal(restored.pages.length,2);assert.equal(restored.pages.find(x=>x.active).url,bUrl);
  const after=await call(A,'act',{action:'evaluate',value:'window.readStore()'});assert.deepEqual(after.result,before.result);record('产品容器重建恢复',{pages:restored.pages,state:after,path:restored.state_path});
  const payload=await (await import('node:fs/promises')).readFile(path.join(repo,'src-tauri/icons/128x128.png'));
  async function sendFile(kind, extra={}) {
    await call(A,'upload_begin',{name:'剪贴板图片.png',size:payload.length});
    const chunk=await call(A,'upload_chunk',{bytes:Array.from(payload)});assert.equal(chunk.received,payload.length);
    const result=await call(A,'upload_finish',{kind,target_id:restored.target_id,...extra});assert.equal(result.uploaded,true);
    const received=await call(A,'act',{action:'evaluate',value:'new Promise((resolve,reject)=>{const end=Date.now()+3000;const check=()=>window.received?resolve(window.received):Date.now()>end?reject(Error("文件未到达")):setTimeout(check,20);check()})'});
    assert.ok(received.result.data.endsWith(payload.toString('base64')));record('真实文件-'+kind,received.result);
  }
  await sendFile('input');
  await call(A,'act',{action:'evaluate',value:'window.received=null'});
  const rectangle=await call(A,'act',{action:'evaluate',value:'(()=>{const r=document.querySelector("#dropzone").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'});
  await sendFile('drop',rectangle.result);
  await call(A,'act',{action:'evaluate',value:'window.received=null;document.querySelector("#paste").focus()'});
  await sendFile('paste');
  // UI粘贴走页面插入：整段多字符文本一次进入，不能被CDP的char单字符限制丢弃。
  await call(A,'act',{action:'click',selector:'#text'});
  const pasteText='粘贴验收😀\n第二行';
  await call(A,'insert_text',{text:pasteText});
  const pasted=await call(A,'act',{action:'get_value',selector:'#text'});
  assert.ok(JSON.stringify(pasted).includes('粘贴验收😀'),'整段粘贴的emoji被截断或丢失');
  assert.ok(JSON.stringify(pasted).includes('第二行'),'整段粘贴的换行文本丢失');record('真实整段粘贴',{textarea:pasted});
  await call(A,'act',{action:'evaluate',value:'document.querySelector("#text").value=""'});
  await call(A,'act',{action:'click',selector:'#download'});
  const downloaded=path.join(restored.state_path,'downloads/browser-download.txt');
  const deadline=Date.now()+5000;
  while(true){try{assert.equal(await readFile(downloaded,'utf8'),'browser-download-evidence');break;}catch(error){if(Date.now()>deadline)throw error;await new Promise(resolve=>setTimeout(resolve,25));}}
  record('真实下载落DB旁',{downloaded});
  await assertFailedManifestIsPreserved(A, restored, aUrl, bUrl, before.result);
  await assertBlobPopupRestoration(A, bUrl, before.result);
  await assertCleanupRetry(A, before.result);
  const afterStopOnly = await assertStopOnlyRecovery(A);
  await assertLargeManifestFromFile(A, afterStopOnly, aUrl, bUrl, before.result);
  await writeFile(path.join(root,'ui-fixture.json'),JSON.stringify({root,db:path.join(root,'app.db'),fixture_port:fixture.port,owners,marker},null,2));
  passed = true; console.log(JSON.stringify({passed:true,root,owners,fixture_port:fixture.port}));
} finally {
  child.stdin.end();await exited;
  await writeFile(path.join(evidence,'trace.json'),JSON.stringify(trace,null,2));
  if(passed && process.argv.includes('--hold')) { console.log('fixture保持运行供隔离APP验收');await new Promise(resolve=>process.once('SIGTERM',resolve)); }
  await fixture.close();
}
