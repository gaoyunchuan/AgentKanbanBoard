// 测量一次冷启动的会话浏览器阶段耗时；使用独立临时状态目录，不接触正式数据。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'akb-timing-'));
await mkdir(path.join(root, 'profile'), { recursive: true });
await mkdir(path.join(root, 'downloads'), { recursive: true });
const started = Date.now();
const child = spawn(process.execPath, [path.join(import.meta.dirname, 'session_browser.mjs')], {
  env: { ...process.env, AKB_BROWSER_OWNER_DIR: root, AKB_AGENT_BROWSER_PATH: path.resolve(import.meta.dirname, '../.build/browser/agent-browser') },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = '';
const ready = await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error('浏览器启动超时')), 90000);
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (const line of buffer.split('\n')) {
      if (!line.trim()) continue;
      try { const value = JSON.parse(line); if (value.ready) { clearTimeout(deadline); resolve(value); } else process.stderr.write(line + '\n'); } catch {}
    }
  });
  child.once('exit', code => reject(new Error(`浏览器进程提前退出（${code}）`)));
});
console.log(JSON.stringify({ wall_ms: Date.now() - started, timings_ms: ready.timings_ms, pages: ready.pages?.length }, null, 2));
child.stdin.end();
await new Promise(resolve => child.once('exit', resolve));
