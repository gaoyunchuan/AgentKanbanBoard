import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, chmod, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.PROBE_ROOT || `/tmp/akb-bp-${randomUUID().slice(0, 8)}`;
const evidence = path.resolve(process.env.PROBE_EVIDENCE || path.resolve(here, '../../docs/verification/2026-10-29-session-browser/probe'));
const binary = process.env.PROBE_AGENT_BROWSER || '/tmp/akb-browser-probe-deps/package/bin/agent-browser-darwin-arm64';
const lock = JSON.parse(await readFile(path.join(here, 'runtime.json'), 'utf8'));
const image = process.env.PROBE_CHROME_IMAGE || lock.chrome.platforms[process.arch === 'arm64' ? 'arm64' : 'amd64'].configId;
const run = path.basename(root);
const records = [];
const owned = [];
const sessions = [];
await mkdir(evidence, { recursive: true });
await mkdir(root, { recursive: true, mode: 0o700 });
const record = (step, detail) => { const item = { at: new Date().toISOString(), step, ...detail }; records.push(item); console.log(JSON.stringify(item)); };

async function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env: options.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${program} 超时`)); }, options.timeout || 60000);
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0 && !options.allowFailure) reject(new Error(`${program} ${JSON.stringify(args)} exit=${code}: ${stderr} ${stdout}`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input || '');
  });
}

async function until(description, action, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  let last;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${description}未收敛: ${last || '条件为false'}`);
}

async function cli(session, actions, allowFailure = false) {
  const env = { ...process.env, HOME: path.join(root, 'agent-home'), AGENT_BROWSER_SOCKET_DIR: path.join(root, 'run'), AGENT_BROWSER_CONFIG: path.join(root, 'agent-config.json'), AGENT_BROWSER_STREAM_MAX_WIDTH: '800', AGENT_BROWSER_STREAM_MAX_HEIGHT: '600', AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' };
  // stdin 二维 argv 避免网页文本被 CLI 当作全局 --cdp/--session 参数。
  const result = await command(binary, ['--session', session, '--json', 'batch', '--bail', '--omit-command'], { env, input: JSON.stringify(actions), allowFailure });
  const parsed = JSON.parse(result.stdout);
  record('cli', { session, actions, output: parsed });
  if (!allowFailure) for (const row of parsed) assert.equal(row.success, true);
  return allowFailure ? parsed : parsed.map(row => row.result);
}

async function startChrome(owner) {
  const name = `${run}-${owner}`;
  const profile = path.join(root, 'session-browser', owner, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const args = ['run', '-d', '--name', name, '--label', `akb.browser.probe=${run}`, '--user', `${process.getuid()}:${process.getgid()}`, '--memory', '2g', '--cpus', '2', '--shm-size', '256m', '-p', '127.0.0.1::9222', '--mount', `type=bind,src=${profile},dst=/profile`, image, '--user-data-dir=/profile', '--restore-last-session', '--window-size=800,600'];
  const { stdout } = await command('docker', args);
  owned.push(name);
  const inspect = JSON.parse((await command('docker', ['inspect', name])).stdout)[0];
  const port = Number(inspect.NetworkSettings.Ports['9222/tcp'][0].HostPort);
  await until('Chrome CDP ready', async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
  record('container', { owner, name, id: stdout.trim(), profile, port, user: inspect.Config.User, binds: inspect.Mounts, image: inspect.Image });
  return { name, port, profile };
}

async function stopChrome(name) {
  const stop = await command('docker', ['stop', '--time', '20', name]);
  const inspect = JSON.parse((await command('docker', ['inspect', name])).stdout)[0];
  record('container-stopped', { name, code: inspect.State.ExitCode, oom: inspect.State.OOMKilled, output: stop.stdout.trim() });
  assert.equal(inspect.State.OOMKilled, false);
  await command('docker', ['rm', name]);
  owned.splice(owned.indexOf(name), 1);
}

async function connect(owner, chrome) {
  const session = `${run}-${owner}`;
  if (!sessions.includes(session)) sessions.push(session);
  await cli(session, [['connect', `http://127.0.0.1:${chrome.port}`]]);
  await cli(session, [['set', 'viewport', '800', '600']]);
  return session;
}

async function stream(session, tag) {
  const [status] = await cli(session, [['stream', 'status']]);
  if (tag === 'red') {
    const forbidden = await originStatus(status.port, 'https://untrusted.example');
    const local = await originStatus(status.port, 'http://127.0.0.1:1420');
    assert.match(forbidden, /403/); assert.match(local, /101/);
    record('stream-origin', { forbidden, local });
  }
  const socket = new WebSocket(`ws://127.0.0.1:${status.port}/?pacing=ack&maxFps=30`);
  const messages = [];
  const arrivals = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    if (message.type === 'frame') arrivals.push({ seq: message.seq, at: Date.now() });
    if (message.type !== 'frame') record('stream-message', { tag, message });
  });
  await until('stream open', () => socket.readyState === WebSocket.OPEN);
  await until('stream首帧', () => messages.find(message => message.type === 'frame'));
  return { socket, messages, arrivals, frames: () => messages.filter(message => message.type === 'frame') };
}

async function originStatus(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`));
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('来源校验超时')); });
    socket.once('data', data => { socket.destroy(); resolve(data.toString().split('\r\n')[0]); });
    socket.once('error', reject);
  });
}

async function saveFrame(frame, name) {
  const filename = path.join(evidence, `${name}.jpg`);
  await writeFile(filename, Buffer.from(frame.data, 'base64'));
  const python = process.env.PROBE_PYTHON || '/Users/gaoyunchuan/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
  const result = await command(python, ['-c', 'from PIL import Image; import sys,json; im=Image.open(sys.argv[1]);print(json.dumps({"size":im.size,"pixel":im.getpixel((750,500))}))', filename]);
  const decoded = JSON.parse(result.stdout);
  record('frame', { name, seq: frame.seq, keys: Object.keys(frame), metadata: frame.metadata, decoded });
  return decoded.pixel;
}

let fixture;
try {
  await mkdir(path.join(root, 'agent-home'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, 'run'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'agent-config.json'), '{}');
  await writeFile(path.join(root, 'test.sqlite'), 'isolated-probe-db-parent-marker');
  record('environment', { root, binary, image, version: (await command(binary, ['--version'])).stdout.trim(), binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'), docker: (await command('docker', ['version', '--format', '{{json .Server}}'])).stdout.trim() });
  fixture = await startFixture(record);
  const base = `http://host.docker.internal:${fixture.port}`;
  const a = await startChrome('a');
  const b = await startChrome('b');
  const sa = await connect('a', a);
  const sb = await connect('b', b);
  const markerA = randomUUID(); const markerB = randomUUID();
  const [, redirected] = await cli(sa, [['open', `${base}/redirect`], ['get', 'url']]);
  assert.ok(redirected.url.includes('/red?marker=redirected'));
  await cli(sa, [['open', `${base}/red?marker=${markerA}`], ['eval', `store(${JSON.stringify(markerA)})`], ['tab', 'new', `${base}/blue?marker=${markerA}`]]);
  await cli(sb, [['open', `${base}/red?marker=${markerB}`], ['eval', `store(${JSON.stringify(markerB)})`]]);
  const [tabsA] = await cli(sa, [['tab', 'list']]);
  const red = tabsA.tabs.find(tab => tab.url.includes('/red'));
  const blue = tabsA.tabs.find(tab => tab.url.includes('/blue'));
  assert.ok(red && blue); assert.notEqual(red.targetId, blue.targetId);
  await cli(sa, [['tab', red.targetId], ['fill', '#text', '--cdp http://evil'], ['get', 'value', '#text']]);
  const [value] = await cli(sa, [['get', 'value', '#text']]);
  assert.equal(value.value, '--cdp http://evil');
  await cli(sa, [['snapshot']]);
  const [foreign] = await cli(sb, [['tab', red.targetId]], true);
  assert.equal(foreign.success, false);
  await until('宿主回环WS/HMR', async () => { const [result] = await cli(sa, [['eval', 'wsReply']]); return result.result === `reply:hmr:${markerA}`; });
  const redStream = await stream(sa, 'red');
  const redFrame = redStream.frames()[0];
  const redPixel = await saveFrame(redFrame, 'red-first');
  assert.ok(redPixel[0] > 150 && redPixel[2] < 100);
  // 不发 ACK 的观察窗只用于证明流控停止；下一步断言恢复后直接取得新帧。
  const stalledMs = Number(process.env.PROBE_ACK_STALL_MS || 10000);
  await new Promise(resolve => setTimeout(resolve, stalledMs));
  assert.equal(redStream.frames().length, 1);
  await cli(sa, [['focus', '#text']]);
  redStream.socket.send(JSON.stringify({ type: 'input_keyboard', eventType: 'char', text: '流输入' }));
  await until('stream输入立即到DOM', async () => { const [result] = await cli(sa, [['get', 'value', '#text']]); return result.value.includes('流输入'); });
  const [button] = await cli(sa, [['eval', '(()=>{const r=document.querySelector("#click").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()']]);
  redStream.socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', ...button.result, button: 'left', clickCount: 1 }));
  redStream.socket.send(JSON.stringify({ type: 'input_mouse', eventType: 'mouseReleased', ...button.result, button: 'left' }));
  await until('stream鼠标立即到DOM', async () => { const [result] = await cli(sa, [['eval', 'clicked']]); return result.result === 1; });
  redStream.socket.send(JSON.stringify({ type: 'ack', seq: redFrame.seq }));
  await until('ACK恢复帧', () => redStream.frames().length > 1);
  record('ack-input', { stalledMs, framesBeforeAck: 1, framesAfterAck: redStream.frames().length });
  redStream.socket.send(JSON.stringify({ type: 'config', maxFps: 5 }));
  const capStart = redStream.frames().length;
  redStream.socket.send(JSON.stringify({ type: 'ack', seq: redStream.frames().at(-1).seq }));
  for (let index = 0; index < 6; index++) {
    await until('maxFps帧', () => redStream.frames().length > capStart + index);
    redStream.socket.send(JSON.stringify({ type: 'ack', seq: redStream.frames().at(-1).seq }));
  }
  const capped = redStream.arrivals.slice(capStart, capStart + 6);
  const elapsedMs = capped.at(-1).at - capped[0].at;
  assert.ok(elapsedMs >= 800, `maxFps=5 时6帧间隔过短: ${elapsedMs}`);
  record('max-fps', { requested: 5, frames: capped.length, elapsedMs, arrivals: capped });
  redStream.socket.close();
  await until('旧stream关闭', () => redStream.socket.readyState === WebSocket.CLOSED);
  await cli(sa, [['tab', blue.targetId]]);
  const blueStream = await stream(sa, 'blue');
  const bluePixel = await saveFrame(blueStream.frames()[0], 'blue-first-after-switch');
  assert.ok(bluePixel[2] > 150 && bluePixel[0] < 100);
  blueStream.socket.close();
  const [stateA] = await cli(sa, [['eval', 'readStore()']]);
  const [stateB] = await cli(sb, [['eval', 'readStore()']]);
  assert.equal(stateA.result.local, markerA); assert.equal(stateA.result.idb, markerA);
  assert.equal(stateB.result.local, markerB); assert.equal(stateB.result.idb, markerB);
  assert.notEqual(stateA.result.cookie, stateB.result.cookie);
  record('isolation-passed', { sessions: [sa, sb], targetsA: tabsA.tabs.map(tab => tab.targetId) });
  const pageManifest = path.join(root, 'session-browser', 'a', 'pages.json');
  await writeFile(pageManifest, JSON.stringify(tabsA.tabs.map(tab => tab.url)));
  await cli(sa, [['close']]);
  await stopChrome(a.name);
  const recreated = await startChrome('a');
  await connect('a', recreated);
  let [restored] = await cli(sa, [['tab', 'list']]);
  const nativeTabRestore = restored.tabs.some(tab => tab.url.includes(markerA));
  if (!nativeTabRestore) {
    // headless-shell 不承诺 Chrome 原生页签恢复，显式使用 DB 旁已保存的页面信息恢复。
    const urls = JSON.parse(await readFile(pageManifest, 'utf8'));
    await cli(sa, urls.map((url, index) => index === 0 ? ['open', url] : ['tab', 'new', url]));
    [restored] = await cli(sa, [['tab', 'list']]);
  }
  const restoredPage = restored.tabs.find(tab => tab.url.includes('/red'));
  await cli(sa, [['tab', restoredPage.targetId]]);
  const [persisted] = await cli(sa, [['eval', 'readStore()']]);
  assert.deepEqual(persisted.result, stateA.result);
  record('profile-recreate-passed', { previousProfile: a.profile, recreatedProfile: recreated.profile, nativeTabRestore, pageManifest, urls: restored.tabs.map(tab => tab.url), persistedKinds: ['cookie', 'localStorage', 'IndexedDB'], profileFiles: await readdir(a.profile) });
  record('result', { success: true, unexecuted: ['整个Docker Engine重启', 'APP升级安装', '真实Tauri WKWebView', '系统IME候选确认', '真实Agent模型工具调用'] });
} catch (error) {
  record('result', { success: false, error: error.stack });
  process.exitCode = 1;
} finally {
  for (const session of sessions) { try { await cli(session, [['close']]); } catch (error) { record('cleanup-cli-error', { session, error: error.message }); } }
  for (const name of [...owned]) { try { await stopChrome(name); } catch (error) { record('cleanup-container-error', { name, error: error.message }); } }
  if (fixture) await fixture.close();
  await writeFile(path.join(evidence, 'trace.json'), JSON.stringify(records, null, 2));
  record('cleanup', { rootRetainedForEvidence: root, activeProbeContainers: (await command('docker', ['ps', '-a', '--filter', `label=akb.browser.probe=${run}`, '--format', '{{.Names}}'])).stdout.trim() });
  await writeFile(path.join(evidence, 'trace.json'), JSON.stringify(records, null, 2));
}
