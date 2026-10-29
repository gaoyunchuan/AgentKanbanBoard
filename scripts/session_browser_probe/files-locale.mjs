// 只改变容器 locale，定位 CDP 上传含中文文件名时的差异。
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dockerLaunchArgs } from '../session_browser_core.mjs';
import { withCdp } from '../session_browser_cdp.mjs';
import { startFixture } from './fixture.mjs';

const root = `/tmp/akb-file-locale-${randomUUID().slice(0, 8)}`;
const evidence = path.resolve(import.meta.dirname, '../../docs/verification/2026-10-29-session-browser/probe/files');
const config = JSON.parse(await readFile(new URL('./runtime.json', import.meta.url)));
const records = [];
const record = (step, value) => { records.push({ at: new Date().toISOString(), step, value }); console.log(step, JSON.stringify(value)); };
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const fixture = await startFixture((step, value) => record(step, value));
const owned = new Set();
async function until(action) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { try { const result = await action(); if (result) return result; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('诊断等待超时');
}
try {
  for (const locale of ['default', 'C.UTF-8', 'en_US.UTF-8']) {
    const suffix = locale.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const directory = path.join(root, suffix);
    const profile = path.join(directory, 'profile'); const downloads = path.join(directory, 'downloads');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await mkdir(path.join(downloads, '.uploads'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(downloads, '.uploads', '剪贴板图片.png'), 'same-content', { mode: 0o600 });
    await writeFile(path.join(downloads, '.uploads', 'ascii.png'), 'same-content', { mode: 0o600 });
    const name = path.basename(root) + '-' + suffix;
    const args = dockerLaunchArgs({ name, namespace: name, image: config.chrome.platforms.arm64.configId, profile, downloads, uid: process.getuid(), gid: process.getgid() });
    // 即使产品默认值之后已修正，也保留镜像原值作为可重复的失败对照。
    const forcedLocale = locale === 'default' ? 'en-US.UTF-8' : locale;
    args.splice(args.indexOf(config.chrome.platforms.arm64.configId), 0, '--env', 'LANG=' + forcedLocale, '--env', 'LC_ALL=' + forcedLocale);
    docker(args); owned.add(name);
    const endpoint = 'http://' + docker(['port', name, '9222/tcp']);
    await until(async () => (await fetch(endpoint + '/json/version')).ok);
    const version = await (await fetch(endpoint + '/json/version')).json();
    const browserSocket = 'ws://' + new URL(endpoint).host + new URL(version.webSocketDebuggerUrl).pathname;
    await withCdp(browserSocket, request => request('Target.createTarget', { url: 'about:blank' }));
    const pages = await (await fetch(endpoint + '/json/list')).json();
    const page = pages.find(item => item.type === 'page');
    const socket = 'ws://' + new URL(endpoint).host + new URL(page.webSocketDebuggerUrl).pathname;
    await withCdp(socket, async request => {
      await request('Page.navigate', { url: `http://host.docker.internal:${fixture.port}/blue?marker=${suffix}` });
      await until(async () => (await request('Runtime.evaluate', { expression: '!!document.querySelector("#file")', returnByValue: true })).result.value);
      const element = await request('Runtime.evaluate', { expression: 'document.querySelector("#file")', returnByValue: false });
      for (const filename of ['剪贴板图片.png', 'ascii.png']) {
        const result = await request('DOM.setFileInputFiles', { objectId: element.result.objectId, files: ['/data/downloads/.uploads/' + filename] });
        const value = await request('Runtime.evaluate', { expression: '({files:[...document.querySelector("#file").files].map(f=>({name:f.name,size:f.size})),received:window.received})', returnByValue: true });
        record('locale-case', { locale, filename, result, value, environment: docker(['exec', name, '/usr/bin/env']).split('\n').filter(line => /^(LANG|LC_ALL)=/.test(line)) });
      }
    });
    docker(['stop', '--timeout', '15', name]); docker(['rm', name]); owned.delete(name);
  }
} finally {
  for (const name of owned) { try { docker(['stop', '--timeout', '15', name]); docker(['rm', name]); } catch {} }
  await fixture.close(); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'locale-trace.json'), JSON.stringify(records, null, 2));
}
