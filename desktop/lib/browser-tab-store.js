const fs = require('node:fs');
const path = require('node:path');

const MAX_OWNERS = 128;
const MAX_TABS = 16;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

class BrowserTabStore {
  constructor(file, validateUrl, onError) {
    this.file = file;
    this.validateUrl = validateUrl;
    this.onError = onError;
    this.timer = null;
    this.readFailed = false;
  }

  load() {
    if (!this.file) return [];
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) throw new Error('浏览器标签记录超过大小上限');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.owners) || saved.owners.length > MAX_OWNERS) {
        throw new Error('浏览器标签记录格式无效');
      }
      return saved.owners.map(owner => this.readOwner(owner));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.readFailed = true;
        this.onError(error);
      }
      return [];
    }
  }

  readOwner({ id, activeId, next, pages }) {
    if (typeof id !== 'string' || !id || id.length > 128 || !Array.isArray(pages) || pages.length > MAX_TABS) {
      throw new Error('浏览器标签会话记录无效');
    }
    const ids = new Set();
    const tabs = pages.map(page => {
      if (!/^tab-[1-9]\d{0,12}$/.test(page.id) || ids.has(page.id)) throw new Error('浏览器标签标识无效');
      ids.add(page.id);
      return { id: page.id, url: this.validateUrl(page.url), title: typeof page.title === 'string' ? page.title.slice(0, 160) : '' };
    });
    const minimum = Math.max(0, ...tabs.map(tab => Number(tab.id.slice(4)))) + 1;
    return { id, activeId: ids.has(activeId) ? activeId : tabs[0]?.id || null,
      next: Number.isSafeInteger(next) && next >= minimum && next < 1e13 ? next : minimum, tabs };
  }

  schedule(readOwners) {
    if (!this.file || this.timer || this.readFailed) return;
    // 合并连续网页导航和焦点切换，避免页面事件放大为磁盘写入。
    this.timer = setTimeout(() => this.flush(readOwners), 300);
    this.timer.unref();
  }

  flush(readOwners) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file || this.readFailed) return;
    const temp = this.file + '.tmp';
    try {
      const content = JSON.stringify({ version: 1, owners: readOwners() });
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('浏览器标签记录超过大小上限');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, content, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      this.onError(error);
    }
  }
}

module.exports = { BrowserTabStore, MAX_OWNERS, MAX_TABS };
