// UI 与 Agent 的命令只连接本应用显式登记的 Docker Chrome。
import path from 'node:path';

function boundedText(value, label, max = 16384) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label}格式或长度无效`);
  return value;
}
function csvField(value) { return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }

export function agentEnvironment(ownerDir, socketDir, inherited = process.env) {
  if (!path.isAbsolute(ownerDir) || !path.isAbsolute(socketDir)) throw new Error('浏览器状态目录必须是绝对路径');
  // 只给浏览器sidecar独立HOME；APP、Codex和用户环境保持原值，避免读取个人CLI配置。
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  Object.assign(env, {
    HOME: path.join(ownerDir, 'agent-home'), AGENT_BROWSER_SOCKET_DIR: socketDir,
    AGENT_BROWSER_CONFIG: path.join(ownerDir, 'agent-config.json'),
    AGENT_BROWSER_STREAM_QUALITY: '65', AGENT_BROWSER_STREAM_MAX_WIDTH: '1600', AGENT_BROWSER_STREAM_MAX_HEIGHT: '1200',
  });
  return env;
}

export function dockerLaunchArgs(p) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(p.name) || !p.image || !path.isAbsolute(p.profile) || !path.isAbsolute(p.downloads)) throw new Error('容器归属或持久目录无效');
  const mount = (source, target) => `type=bind,${csvField('source=' + source)},target=${target}`;
  return ['run', '--detach', '--name', p.name, '--label', 'local.codex.kanban.browser=true',
    '--label', `local.codex.kanban.state=${p.namespace || p.name}`,
    '--publish', '127.0.0.1::9222', '--user', `${p.uid}:${p.gid}`,
    '--env', 'HOME=/data/profile', '--env', 'LANG=C.UTF-8', '--env', 'LC_ALL=C.UTF-8', '--mount', mount(p.profile, '/data/profile'), '--mount', mount(p.downloads, '/data/downloads'),
    '--cpus', '2', '--memory', '2g', '--pids-limit', '256', '--shm-size', '256m', '--tmpfs', '/tmp:rw,size=128m',
    '--log-driver', 'local', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=2',
    p.image, '--user-data-dir=/data/profile', '--password-store=basic', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--window-size=1280,900'];
}

export function cdpWebSocket(endpoint, version) {
  const base = new URL(endpoint), advertised = new URL(version.webSocketDebuggerUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(advertised.pathname)) throw new Error('容器未返回有效的本地CDP连接');
  // Docker端口映射不同于容器内广告端口，只沿用已验证的browser路径。
  return `ws://${base.host}${advertised.pathname}`;
}

export function actionCommands(p) {
  const selector = () => boundedText(p.selector, '页面元素');
  const value = () => boundedText(p.value ?? p.key, '输入内容');
  if (['click', 'dblclick', 'hover', 'focus', 'check', 'uncheck'].includes(p.action)) return [[p.action, selector()]];
  if (['fill', 'type', 'select'].includes(p.action)) return [[p.action, selector(), value()]];
  if (p.action === 'press') return [['press', value()]];
  if (p.action === 'evaluate') return [['eval', value()]];
  if (p.action === 'get_text') return [['get', 'text', selector()]];
  if (p.action === 'get_value') return [['get', 'value', selector()]];
  if (['back', 'forward', 'reload', 'console', 'errors'].includes(p.action)) return [[p.action]];
  if (p.action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(p.direction)) throw new Error('滚动方向无效');
    const amount = Math.max(1, Math.min(3000, Math.round(Number(p.amount) || 500)));
    return [['scroll', p.direction, String(amount)]];
  }
  throw new Error('不支持的页面操作');
}

export function snapshotCommand(p) {
  // Agent需要读取正文证据；仅交互元素的快照会漏掉报告、提示和页面标记。
  return p.selector === undefined ? ['snapshot'] : ['snapshot', '-s', boundedText(p.selector, '快照范围')];
}

export function validateBrowserUrl(value) {
  if (value === 'about:blank') return value;
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) throw new Error('地址仅支持无凭据HTTP/HTTPS或about:blank');
  return url.href;
}

export function restorePageDescriptor(saved) {
  const title = String(saved.title || '').slice(0, 8000);
  const temporary = /^(blob|data):/i.test(saved.url);
  const placeholder = saved.url === 'about:blank' && title.startsWith('临时页面未恢复：');
  if (!temporary && !placeholder) return { url: validateBrowserUrl(saved.url), title, notice: null };
  // 临时地址不再有效，也不能重放内嵌脚本；保留一个可见占位，继续恢复其他正常页面。
  return {
    url: 'about:blank',
    title: placeholder ? title : `临时页面未恢复：${title || '未命名页面'}`,
    notice: '此页面使用临时 Blob 或内嵌数据地址，浏览器重启后无法继续恢复。为避免重放旧内容，请回到来源页面重新打开。',
  };
}

/** 中文字体层使用固定标签：基础镜像 digest 决定具体层，重复准备可命中缓存。 */
export function cjkImageTag(configId, architecture) {
  const digest = String(configId).replace(/^sha256:/, '').slice(0, 12);
  return `akb-chrome-cjk-${architecture}:${digest}`;
}

export function createRetryableCleanup(operation) {
  let cleanupPromise, closed = false;
  return () => {
    if (closed) return Promise.resolve();
    // 并发关闭共用本次确认；失败保留资源上下文，下一次调用重新真实清理。
    if (!cleanupPromise) cleanupPromise = Promise.resolve().then(operation).then(() => { closed = true; }).finally(() => { cleanupPromise = undefined; });
    return cleanupPromise;
  };
}

export async function stopOwnedContainer(executeDocker, name, namespace) {
  const found = await executeDocker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
  if (!found) return { stopped: true, removed: true };
  const label = await executeDocker(['inspect', '--format', '{{index .Config.Labels "local.codex.kanban.state"}}', name]);
  if (label !== namespace) throw new Error('容器归属不匹配，拒绝停止或删除');
  await executeDocker(['stop', '--time', '15', name]);
  await executeDocker(['rm', name]);
  return { stopped: true, removed: true };
}
