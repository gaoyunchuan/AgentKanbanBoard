// 每个会话一个 WebContentsView 与独立持久分区；网页由内嵌 Chromium 原生渲染。
const { WebContentsView } = require('electron');
const { partitionFor } = require('./sessions');
const { normalizeUrl } = require('./url');

const TOOLBAR_HEIGHT = 56;
const SIDEBAR_WIDTH = 280;

class BrowserManager {
  constructor(window, options = {}) {
    this.window = window;
    this.views = new Map();
    this.active = null;
    this.validateUrl = options.validateUrl || normalizeUrl;
    this.window.on('resize', () => this.layout());
  }

  layout() {
    const entry = this.active && this.views.get(this.active);
    if (!entry) return;
    const [width, height] = this.window.getContentSize();
    entry.view.setBounds({
      x: SIDEBAR_WIDTH, y: TOOLBAR_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH), height: Math.max(0, height - TOOLBAR_HEIGHT),
    });
  }

  ensure(conversationId) {
    let entry = this.views.get(conversationId);
    if (!entry) {
      const partition = partitionFor(conversationId);
      const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true } });
      const notify = () => this.window.webContents.send('browser:changed', this.snapshot(conversationId));
      for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
        view.webContents.on(event, notify);
      }
      entry = { view, partition };
      this.views.set(conversationId, entry);
    }
    return entry;
  }

  hideCurrent() {
    if (!this.active) return;
    const entry = this.views.get(this.active);
    if (entry) { try { this.window.contentView.removeChildView(entry.view); } catch {} }
  }

  async show(conversationId, url) {
    const entry = this.ensure(conversationId);
    if (this.active !== conversationId) { this.hideCurrent(); this.active = conversationId; }
    // 重复 addChildView 会抛错；先移除再挂载，保证切换幂等。
    try { this.window.contentView.removeChildView(entry.view); } catch {}
    this.window.contentView.addChildView(entry.view);
    this.layout();
    if (url) await this.navigate(conversationId, url);
    return this.snapshot(conversationId);
  }

  navigate(conversationId, url) {
    const entry = this.ensure(conversationId);
    return entry.view.webContents.loadURL(this.validateUrl(url))
      // 新导航会中止上一次 about:blank/旧页面，这是正常的竞态，不是失败。
      .catch(error => { if (error && error.code !== 'ERR_ABORTED') throw error; })
      .then(() => this.snapshot(conversationId));
  }

  history(conversationId, action) {
    const entry = this.ensure(conversationId);
    const navigation = entry.view.webContents.navigationHistory;
    if (action === 'back' && navigation.canGoBack()) navigation.goBack();
    if (action === 'forward' && navigation.canGoForward()) navigation.goForward();
    if (action === 'reload') entry.view.webContents.reload();
    return this.snapshot(conversationId);
  }

  snapshot(conversationId) {
    const entry = this.views.get(conversationId);
    const contents = entry && entry.view.webContents;
    const navigation = contents && contents.navigationHistory;
    return {
      conversationId, partition: entry ? entry.partition : null,
      bounds: entry ? entry.view.getBounds() : null,
      url: contents ? contents.getURL() : '',
      title: contents ? contents.getTitle() : '',
      canGoBack: navigation ? navigation.canGoBack() : false,
      canGoForward: navigation ? navigation.canGoForward() : false,
      loading: contents ? contents.isLoading() : false,
    };
  }

  list() {
    return [...this.views.keys()].map(id => this.snapshot(id));
  }

  dispose() {
    for (const entry of this.views.values()) { try { entry.view.webContents.close(); } catch {} }
    this.views.clear(); this.active = null;
  }
}

module.exports = { BrowserManager, normalizeUrl, TOOLBAR_HEIGHT, SIDEBAR_WIDTH };
