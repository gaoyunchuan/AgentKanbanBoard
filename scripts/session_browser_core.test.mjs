import test from 'node:test';
import assert from 'node:assert/strict';
import { agentEnvironment, dockerLaunchArgs, cdpWebSocket, actionCommands, snapshotCommand, cjkImageTag } from './session_browser_core.mjs';

test('中文字体层标签绑定基础镜像摘要，准备与启动使用同一标签', () => {
  assert.equal(cjkImageTag('sha256:a8eda062ca7bb9d9696212c14e6e9e8d7c12b599b988e52ec9ec52a7d1a9106d', 'arm64'), 'akb-chrome-cjk-arm64:a8eda062ca7b');
});

test('页面快照保留普通正文，并尊重调用者指定的元素范围', () => {
  assert.deepEqual(snapshotCommand({}), ['snapshot']);
  assert.deepEqual(snapshotCommand({ selector: '#secret-marker' }), ['snapshot', '-s', '#secret-marker']);
  assert.throws(() => snapshotCommand({ selector: 'x'.repeat(16385) }));
});

test('子进程状态跟随DB目录，父进程HOME和个人浏览器设置不被继承或修改', () => {
  const home = process.env.HOME;
  const env = agentEnvironment('/tmp/测试 数据库/browser-state/app.db/owner', '/tmp/akb-socket-test', { HOME: home, AGENT_BROWSER_CDP: 'http://other', AGENT_BROWSER_AUTO_CONNECT: '1', PATH: '/usr/bin' });
  assert.equal(env.HOME, '/tmp/测试 数据库/browser-state/app.db/owner/agent-home');
  assert.equal(env.AGENT_BROWSER_SOCKET_DIR, '/tmp/akb-socket-test');
  assert.equal(env.AGENT_BROWSER_AUTO_CONNECT, undefined);
  assert.equal(env.AGENT_BROWSER_CDP, undefined);
  assert.equal(process.env.HOME, home);
});
test('容器重建继续挂载原profile与下载目录，特殊路径不会变成额外Docker参数', () => {
  const p = { name: 'akb-test', image: 'test/chrome@sha256:123', profile: '/tmp/数据库, "state"/profile', downloads: '/tmp/数据库/downloads', uid: 501, gid: 20, chrome: '/opt/chrome' };
  const args = dockerLaunchArgs(p);
  assert.ok(args.includes('127.0.0.1::9222')); 
  assert.ok(args.includes('type=bind,"source=/tmp/数据库, ""state""/profile",target=/data/profile'));
  assert.ok(args.includes('type=bind,source=/tmp/数据库/downloads,target=/data/downloads'));
  assert.ok(args.includes('501:20'));
  assert.ok(args.includes('LANG=C.UTF-8')); assert.ok(args.includes('LC_ALL=C.UTF-8'));
  assert.ok(!args.some(x => /privileged|user-data-dir=\/tmp|tmpfs.*profile/.test(x)));
});
test('只保留真实CDP browser路径，忽略容器广告的不可达主机和端口', () => {
  assert.equal(cdpWebSocket('http://127.0.0.1:35222', { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' }), 'ws://127.0.0.1:35222/devtools/browser/abc');
  assert.throws(() => cdpWebSocket('http://evil:9222', { webSocketDebuggerUrl: 'ws://evil/devtools/browser/x' }));
  assert.throws(() => cdpWebSocket('http://127.0.0.1:35222', { webSocketDebuggerUrl: 'ws://localhost/other' }));
});
test('动作是固定命令和JSON数据，任意文本不变成session/CDP选项', () => {
  assert.deepEqual(actionCommands({ action: 'fill', selector: '#text', value: '--cdp http://evil' }), [['fill', '#text', '--cdp http://evil']]);
  assert.deepEqual(actionCommands({ action: 'click', selector: '@e1' }), [['click', '@e1']]);
  assert.throws(() => actionCommands({ action: 'connect', value: 'other' }));
  assert.throws(() => actionCommands({ action: 'fill', selector: '#text', value: 'x'.repeat(16385) }));
});

test('容器停止失败不能假报已停止，也不能删除归属不匹配的容器', async () => {
  const { stopOwnedContainer: stop } = await import('./session_browser_core.mjs');
  const successCalls=[]; const success=await stop(async args=>{successCalls.push(args);return args[0]==='ps'?'container':args[0]==='inspect'?'ours':'';},'akb-test','ours');
  assert.equal(success.stopped,true);assert.ok(successCalls.some(args=>args[0]==='rm'));

  const { stopOwnedContainer } = await import('./session_browser_core.mjs');
  const calls = [];
  await assert.rejects(stopOwnedContainer(async args => { calls.push(args); if (args[0] === 'ps') return 'container'; if (args[0] === 'inspect') return 'other'; return ''; }, 'akb-test', 'ours'));
  assert.ok(!calls.some(args => args[0] === 'stop' || args[0] === 'rm'));
  await assert.rejects(stopOwnedContainer(async args => { if (args[0] === 'ps') return 'container'; if (args[0] === 'inspect') return 'ours'; throw new Error('Docker不可用'); }, 'akb-test', 'ours'));
});

test('关闭失败后可以重试，重入共享同一次清理，成功后保持幂等', async () => {
  const { createRetryableCleanup } = await import('./session_browser_core.mjs');
  assert.equal(typeof createRetryableCleanup, 'function');
  let attempts = 0, removed = false, allowFinish;
  const finish = new Promise(resolve => { allowFinish = resolve; });
  const cleanup = createRetryableCleanup(async () => {
    attempts++;
    if (attempts === 1) throw new Error('Docker stop暂时失败');
    await finish;
    removed = true;
  });
  await assert.rejects(cleanup(), /Docker stop暂时失败/);
  assert.equal(removed, false);
  const retry = cleanup();
  assert.equal(cleanup(), retry);
  allowFinish();
  await retry;
  await cleanup();
  assert.equal(removed, true);
  assert.equal(attempts, 2);
});

test('临时blob和data页恢复为空白占位，正常页面保持URL且占位说明可再次恢复', async () => {
  const { restorePageDescriptor } = await import('./session_browser_core.mjs');
  assert.equal(typeof restorePageDescriptor, 'function');
  for (const url of ['blob:http://localhost/temporary', 'data:text/html,<script>sideEffect()</script>']) {
    const result = restorePageDescriptor({ url, title: '临时报表' });
    assert.equal(result.url, 'about:blank');
    assert.ok(result.title.includes('临时页面未恢复'));
    assert.ok(result.notice.includes('重新打开'));
    const again = restorePageDescriptor({ url: result.url, title: result.title });
    assert.equal(again.title, result.title);
    assert.ok(again.notice);
  }
  assert.deepEqual(restorePageDescriptor({ url: 'https://example.com/report?q=1', title: '正常报表' }), { url: 'https://example.com/report?q=1', title: '正常报表', notice: null });
});
