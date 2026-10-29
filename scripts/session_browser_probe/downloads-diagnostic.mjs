// 对比下载配置连接关闭/保持的真实效果，不修改产品实现。
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { startFixture } from './fixture.mjs';
import { withCdp } from '../session_browser_cdp.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const root = `/tmp/akb-download-${randomUUID().slice(0, 8)}`;
const evidence = path.join(repo, 'docs/verification/2026-10-29-session-browser/probe/files');
await mkdir(root, { recursive: true }); await mkdir(evidence, { recursive: true });
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
  else if (pending.has(reply.id)) { const item = pending.get(reply.id); pending.delete(reply.id); clearTimeout(item.timer); reply.error ? item.reject(new Error(reply.error)) : item.resolve(reply.result); }
});
function call(owner, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = next++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}超时`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, owner, method, params }) + '\n');
  });
}
async function observeDownload(directory) {
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    const files = (await readdir(directory)).filter(name => name.endsWith('.txt'));
    if (files.length) return Promise.all(files.map(async name => ({ name, content: await readFile(path.join(directory, name), 'utf8') })));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return [];
}
try {
  const { owners } = await initialized; const owner = owners[0].owner;
  await call(owner, 'status');
  await call(owner, 'navigate', { url: `http://host.docker.internal:${fixture.port}/blue?marker=downloads-diagnostic` });
  const state = await call(owner, 'status'); const directory = path.join(state.state_path, 'downloads');
  const container = 'akb-' + createHash('sha256').update(state.state_path).digest('hex').slice(0, 24);
  const endpoint = 'http://' + execFileSync('docker', ['port', container, '9222/tcp'], { encoding: 'utf8' }).trim();
  const version = await (await fetch(endpoint + '/json/version')).json();
  const socket = 'ws://' + new URL(endpoint).host + new URL(version.webSocketDebuggerUrl).pathname;
  record('setup', { root, state, container });
  const configure = request => request('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/data/downloads', eventsEnabled: true });
  await withCdp(socket, configure);
  await call(owner, 'act', { action: 'click', selector: '#download' });
  record('closed-configuration', await observeDownload(directory));
  await withCdp(socket, async request => {
    await configure(request);
    await call(owner, 'act', { action: 'click', selector: '#download' });
    const files = await observeDownload(directory);
    record('live-configuration', files);
    for (const file of files) await unlink(path.join(directory, file.name));
  });
  await call(owner, 'act', { action: 'click', selector: '#download' });
  record('after-live-disconnected', await observeDownload(directory));
} catch (error) { record('failure', error.stack); process.exitCode = 1; }
finally {
  child.stdin.end(); await exited; await fixture.close();
  await writeFile(path.join(evidence, 'download-trace.json'), JSON.stringify(trace, null, 2));
}
