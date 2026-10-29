// 只编排本应用拥有的容器与固定sidecar；页面显示由agent-browser原生stream承担。
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { agentEnvironment, dockerLaunchArgs, cdpWebSocket, actionCommands, stopOwnedContainer, snapshotCommand, createRetryableCleanup, restorePageDescriptor, cjkImageTag, validateBrowserUrl as validateUrl } from './session_browser_core.mjs';
import { configureDownloads, insertTextIntoFocused, uploadToPage, createBlankPage, navigateTargetWithoutWaiting } from './session_browser_cdp.mjs';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const maxPages = 16;
let initialized = false, restorationComplete = false, containerOwned = false, agentAttached = false, downloadSession, docker, agent, session, endpoint, streamUrl, runtimeConfig, context, agentEnv;
const restorationNotices = new Map();
// 后台导航尚未提交时保留原URL写回manifest，避免首次打开期间把原始页面清单覆盖成空白页。
const pendingRestores = new Map();
// 启动阶段耗时只用于诊断：容器、页面恢复和画面流各自时间，不含正文或地址。
const startedAt = Date.now(), timings = {};
const mark = name => { timings[name] = Date.now() - startedAt; };

async function execute(executable, args, { input, env = process.env, deadline = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', failure;
    const timer = setTimeout(() => { failure = new Error('浏览器命令超时，未知操作不会自动重放'); child.kill('SIGKILL'); }, deadline);
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 1_048_576) { failure = new Error('浏览器返回内容超过限制'); child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { if (errors.length < 8192) errors += chunk.toString().slice(0, 8192 - errors.length); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`浏览器命令失败（退出码${code}）：${(errors || output).replace(/(?:https?|wss?):\/\/\S+/g, '[连接地址]').slice(0, 800)}`));
      else resolve(output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
async function agentJson(args, options = {}) {
  const output = await execute(agent, ['--session', session, '--json', ...args], { env: agentEnv, ...options });
  try { return JSON.parse(output); } catch { throw new Error('浏览器工具未返回有效JSON'); }
}
async function batch(commands) {
  // 所有页面文本在JSON stdin中传递，不能让“--cdp”等文字变成CLI全局参数。
  const response = await agentJson(['--cdp', context.cdp, 'batch', '--bail', '--omit-command'], { input: JSON.stringify(commands) });
  if (!Array.isArray(response)) throw new Error('浏览器批量结果格式不兼容');
  const failed = response.find(row => row.success !== true);
  if (failed) throw new Error(typeof failed.error === 'string' ? failed.error.slice(0, 1200) : '页面操作失败');
  return response.map(row => row.result);
}
async function pages() {
  const [data] = await batch([['tab', 'list']]);
  if (!Array.isArray(data?.tabs)) throw new Error('无法读取本会话页面列表');
  for (const id of restorationNotices.keys()) if (!data.tabs.some(t => t.targetId === id && t.url === 'about:blank')) restorationNotices.delete(id);
  return data.tabs.filter(t => t.type === 'page').map(t => {
    const notice = restorationNotices.get(t.targetId);
    return { id: t.targetId, title: notice?.title || t.title || '', url: t.url || 'about:blank', active: Boolean(t.active), ...(notice ? { restoration_notice: notice.notice } : {}) };
  });
}
async function selectTarget(id) {
  const list = await pages();
  if (id && !list.some(p => p.id === id)) throw new Error('页面已关闭或不属于本会话');
  if (id && !list.find(p => p.id === id)?.active) await batch([['tab', id]]);
  return list;
}
async function currentState() {
  const list = await pages();
  if (list.length > maxPages) throw new Error('本会话页面超过16个，请关闭多余页面');
  for (const page of list) if (page.url !== 'about:blank') pendingRestores.delete(page.id);
  const active = Math.max(0, list.findIndex(p => p.active));
  return { pages: list, target_id: list[active]?.id || null,
    manifest: { version: 1, pages: list.map(({ id, title, url }) => ({ title: title.slice(0, 8192), url: pendingRestores.get(id) || url })), active_index: list.length ? active : null } };
}
async function restorePages(manifest) {
  if (!manifest?.pages?.length) return;
  const descriptors = manifest.pages.map(restorePageDescriptor);
  const list = await pages(), blanks = list.filter(p => p.url === 'about:blank');
  const needed = Math.max(0, descriptors.length - blanks.length);
  const created = needed ? await Promise.all(Array.from({ length: needed }, () => createBlankPage(endpoint))) : [];
  const ids = [...blanks.map(p => p.id), ...created.map(page => page.id)].slice(0, descriptors.length);
  // 建成全部页签后并行派发导航；Chrome在后台加载，首次打开不再逐个等待页面网络。
  const restorable = descriptors.map((descriptor, index) => ({ descriptor, id: ids[index] })).filter(({ id }) => id);
  await Promise.allSettled(restorable.map(({ descriptor, id }) => {
    if (descriptor.url === 'about:blank') return Promise.resolve();
    pendingRestores.set(id, descriptor.url);
    return navigateTargetWithoutWaiting(endpoint, id, descriptor.url);
  }));
  for (const { descriptor, id } of restorable) if (descriptor.notice) await showRestorationNotice(id, descriptor);
  await selectTarget(ids[manifest.active_index ?? 0]);
}
async function showRestorationNotice(id, descriptor) {
  await selectTarget(id);
  const script = `(()=>{document.title=${JSON.stringify(descriptor.title)};const body=document.body||document.documentElement.appendChild(document.createElement('body'));const message=document.createElement('p');message.textContent=${JSON.stringify(descriptor.notice)};body.replaceChildren(message);return true})()`;
  await batch([['eval', script]]);
  restorationNotices.set(id, descriptor);
}
async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error('Docker浏览器尚未就绪');
  return response.json();
}
async function dockerExecutable() {
  for (const file of [process.env.AKB_DOCKER_PATH, '/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'].filter(Boolean)) {
    try { await access(file); return file; } catch {}
  }
  return 'docker';
}
function prepareOwnerContext() {
  const root = process.env.AKB_BROWSER_OWNER_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error('缺少数据库绑定的浏览器目录');
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24);
  session = `akb-${key}`;
  context = { root, name: session, namespace: key, profile: path.join(root, 'profile'), downloads: path.join(root, 'downloads') };
}
async function prepareContext() {
  prepareOwnerContext();
  // macOS的TMPDIR通常很长，Unix socket必须用固定短运行路径；持久state仍在DB旁。
  const socketDir = path.join('/tmp', `akb-${context.namespace.slice(0, 16)}`);
  agentEnv = agentEnvironment(context.root, socketDir);
  for (const directory of [agentEnv.HOME, socketDir]) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
  await writeFile(agentEnv.AGENT_BROWSER_CONFIG, '{}', { mode: 0o600 });
  agent = process.env.AKB_AGENT_BROWSER_PATH;
  if (!agent || !path.isAbsolute(agent)) throw new Error('缺少固定版本agent-browser运行时，请准备浏览器环境');
  runtimeConfig = JSON.parse(await readFile(new URL('./session_browser_probe/runtime.json', import.meta.url), 'utf8'));
  const version = await execute(agent, ['--version'], { env: agentEnv });
  if (version !== `agent-browser ${runtimeConfig.agentBrowser.version}`) throw new Error('agent-browser版本与当前应用不匹配');
  docker = await dockerExecutable();
}
async function startContainer() {
  const architecture = await execute(docker, ['version', '--format', '{{.Server.Arch}}']);
  const image = runtimeConfig.chrome.platforms[architecture];
  if (!image) throw new Error('当前Docker架构尚未准备浏览器镜像');
  try { await execute(docker, ['image', 'inspect', image.configId]); }
  catch { throw new Error('浏览器Docker镜像尚未准备，请先下载固定浏览器环境'); }
  // 字体层是基础镜像的派生层；缺失时回退基础镜像并保持可用，准备环境后中文正常。
  let runtimeImage = image.configId;
  try { await execute(docker, ['image', 'inspect', cjkImageTag(image.configId, architecture)]); runtimeImage = cjkImageTag(image.configId, architecture); } catch {}
  // 上次APP异常退出后，旧容器仍可能运行；先精确停止它，绝不并用同一profile。
  const found = await execute(docker, ['ps', '-a', '--filter', `name=^/${context.name}$`, '--format', '{{.ID}}']);
  if (found) {
    const label = await execute(docker, ['inspect', '--format', '{{index .Config.Labels "local.codex.kanban.state"}}', context.name]);
    if (label !== context.namespace) throw new Error('同名容器归属不匹配，拒绝修改');
    containerOwned = true;
    await execute(docker, ['stop', '--time', '15', context.name], { deadline: 20000 });
    await execute(docker, ['rm', context.name]);
  }
  await execute(docker, dockerLaunchArgs({ ...context, image: runtimeImage, uid: process.getuid(), gid: process.getgid() }), { deadline: 30000 });
  containerOwned = true;
  const port = await execute(docker, ['port', context.name, '9222/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Chrome未绑定本机端口');
  endpoint = `http://${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { context.cdp = cdpWebSocket(endpoint, await fetchJson(`${endpoint}/json/version`)); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Docker Chrome启动超时');
}
async function initialize() {
  await prepareContext();
  mark('context');
  await startContainer();
  mark('docker');
  downloadSession = await configureDownloads(context.cdp);
  mark('downloads');
  agentAttached = true;
  await batch([['tab', 'list']]);
  mark('agent');
  const manifest = await readSavedManifest();
  await restorePages(manifest);
  restorationComplete = true;
  mark('pages');
  const status = await agentJson(['stream', 'status']);
  const stream = status.data || status;
  if (!Number.isInteger(stream.port)) throw new Error('浏览器未提供stream端口');
  streamUrl = `ws://127.0.0.1:${stream.port}/?pacing=ack&maxFps=30`;
  mark('stream');
  return { endpoint, stream_url: streamUrl, timings_ms: timings, ...(await currentState()) };
}
async function readSavedManifest() {
  const filename = process.env.AKB_BROWSER_MANIFEST_PATH;
  if (!filename) return JSON.parse(process.env.AKB_BROWSER_SAVED_PAGES || 'null');
  if (!path.isAbsolute(filename)) throw new Error('页面清单路径必须是绝对路径');
  // 清单可达256KiB，不能放进Linux单个env值（常见128KiB上限）。
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function dispatch(method, p) {
  if (['status', 'list_pages'].includes(method)) return currentState();
  if (method === 'upload') { const state = await currentState(); if (p.target_id && p.target_id !== state.target_id) throw new Error('上传目标页面已变化，请重新选择文件'); return uploadToPage(endpoint, state.target_id, p.path, p.selector || 'input[type=file]', p.kind || 'input', p); }
  if (method === 'snapshot') { await selectTarget(p.target_id); return (await batch([snapshotCommand(p)]))[0]; }
  if (method === 'insert_text') {
    const list = await selectTarget(p.target_id), target = p.target_id || list.find(x => x.active)?.id;
    if (!target) throw new Error('没有可用的网页');
    return insertTextIntoFocused(endpoint, target, p.text);
  }
  if (['activate_page', 'select_page'].includes(method)) { await selectTarget(p.target_id); return currentState(); }
  if (['new_page', 'open_page'].includes(method)) {
    if ((await pages()).length >= maxPages) throw new Error('每会话最多16个页面');
    await batch([['tab', 'new', validateUrl(p.url || 'about:blank')]]); return currentState();
  }
  if (['close_page'].includes(method)) {
    const list = await pages(), target = p.target_id || list.find(x => x.active)?.id;
    if (!list.some(x => x.id === target)) throw new Error('页面已关闭或不属于本会话');
    if (list.length === 1) await batch([['tab', 'new', 'about:blank']]);
    await batch([['tab', 'close', target]]); return currentState();
  }
  await selectTarget(p.target_id);
  if (method === 'navigate') await batch([['open', validateUrl(p.url)]]);
  else if (['reload', 'back', 'forward'].includes(method)) await batch([[method]]);
  else if (method === 'act') return (await batch(actionCommands(p)))[0];
  else if (method === 'resize') await batch([['set', 'viewport', String(Math.max(320, Math.min(1600, Math.round(p.width || 1000)))), String(Math.max(240, Math.min(1200, Math.round(p.height || 800))))]]);
  else throw new Error('不支持的浏览器操作');
  return currentState();
}
const close = createRetryableCleanup(async () => {
  if (!context) return;
  docker ||= await dockerExecutable();
  // 恢复中途失败只能保留原清单；部分页面和新空白页不能覆盖上次完整状态。
  if (containerOwned && initialized && restorationComplete) { try { emit({ event: 'saved_pages', state: await currentState() }); } catch {} }
  // 下载连接持有到Chrome停止；只有stop/rm确认后才释放归属，失败可再次关闭。
  if (agentAttached) { try { await agentJson(['close'], { deadline: 10000 }); } catch {} }
  // docker run可能已创建但响应超时；即使owned尚未置true也必须按精确归属查询。
  await stopOwnedContainer(args => execute(docker, args, { deadline: 20000 }), context.name, context.namespace);
  containerOwned = false;
  agentAttached = false;
  downloadSession?.close(); downloadSession = undefined;
});
async function runProtocol() {
  process.on('SIGTERM', async () => { try { await close(); emit({ cleanup_complete: true }); process.exit(0); } catch (error) { emit({ error: '容器停止未确认，持久状态保留：' + error.message }); process.exit(1); } });
  try {
    emit({ ready: true, ...(await initialize()) });
    initialized = true;
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let request;
      try {
        if (Buffer.byteLength(line) > 1_048_576) throw new Error('浏览器请求过大');
        request = JSON.parse(line);
        if (request.method === 'shutdown') { await close(); emit({ id: request.id, result: { stopped: true } }); break; }
        const result = await dispatch(request.method, request.params || {});
        emit({ id: request.id, result, state: await currentState() });
      } catch (error) { emit({ id: request?.id, error: String(error?.message || error) }); }
    }
  } catch (error) { emit({ ready: false, error: String(error?.message || error) }); process.exitCode = 1; }
  finally { try { await close(); emit({ cleanup_complete: true }); } catch (error) { emit({ error: '容器停止未确认，持久状态保留：' + error.message }); process.exitCode = 1; } }
}
if (process.argv.includes('--stop-only')) {
  // 失败启动的兜底清理不能依赖agent、版本文件或镜像缓存，也不能启动新资源。
  try { prepareOwnerContext(); await close(); emit({ cleanup_complete: true }); }
  catch (error) { emit({ error: '容器停止未确认，持久状态保留：' + error.message }); process.exitCode = 1; }
} else await runProtocol();
