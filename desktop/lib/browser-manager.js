// 每个会话一组 WebContentsView（原生 Chromium），由一个渲染进程上报面板矩形来摆放。
const { WebContentsView, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { BrowserTabStore, MAX_OWNERS, MAX_TABS } = require('./browser-tab-store');
const { defaults, validatedShortcuts, browserShortcut } = require('./workspace-shortcuts');
const MAX_LIVE_VIEWS = 8;

function partitionFor(conversationId) {
  const safe = String(conversationId || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const digest = createHash('sha256').update(String(conversationId)).digest('hex').slice(0, 8);
  return 'persist:akb-' + safe + '-' + digest;
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('地址不能为空');
  if (text === 'about:blank') return text;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) throw new Error('仅支持无凭据的 HTTP/HTTPS 地址');
  return url.href;
}

function browserPreferences(partition) {
  return { partition, nodeIntegration: false, contextIsolation: true, sandbox: true };
}

class BrowserManager {
  constructor(window, options = {}) {
    this.window = window;
    this.conversations = new Map();
    this.activeConversation = null;
    this.visible = false;
    this.shortcuts = defaults;
    this.viewLimit = options.viewLimit || MAX_LIVE_VIEWS;
    this.tick = 0;
    this.revision = 0;
    this.leases = new Map();
    this.storageError = false;
    this.store = new BrowserTabStore(options.manifest, normalizeUrl, error => this.reportStorageError(error));
    for (const saved of this.store.load()) {
      this.conversations.set(saved.id, { partition: partitionFor(saved.id), tabs: new Map(saved.tabs.map(tab => [tab.id, tab])),
        activeId: saved.activeId, next: saved.next, revision: 0 });
    }
    this.rect = options.rect || { x: 0, y: 0, width: 0, height: 0 };
    this.downloads = options.downloads || path.join(process.env.HOME || '', '.codex-kanban', 'downloads');
    fs.mkdirSync(this.downloads, { recursive: true });
    this.window.on('resize', () => this.layout());
  }

  downloadPath() { return this.downloads; }
  activeContents(conversationId) {
    const conversation = this.conversations.get(conversationId);
    const tab = conversation && conversation.tabs.get(conversation.activeId);
    return tab?.view?.webContents || null;
  }
  setRect(conversationId, rect) {
    if (!rect || !Number.isFinite(rect.x) || rect.width < 2 || rect.height < 2) return;
    this.hide();
    this.activeConversation = conversationId;
    this.visible = true;
    this.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const conversation = this.conversations.get(conversationId);
    if (conversation && conversation.activeId) this.activate(conversationId, conversation.activeId);
  }

  hide(restoreFocus = false) {
    // 网页激活可来自 Agent；只有可见面板的矩形上报拥有原生视图显示权。
    const guestFocused = restoreFocus && this.visible && this.activeContents(this.activeConversation)?.isFocused?.();
    this.visible = false;
    for (const conversation of this.conversations.values()) for (const tab of conversation.tabs.values()) {
      try { if (tab.view) this.window.contentView.removeChildView(tab.view); } catch {}
    }
    if (guestFocused) this.window.webContents.focus();
  }

  activateConversation(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.tabs.size) this.newTab(conversationId, 'about:blank');
    else this.activate(conversationId, conversation.activeId);
  }

  layout() {
    if (!this.visible) return;
    const conversation = this.activeConversation && this.conversations.get(this.activeConversation);
    if (!conversation) return;
    const tab = conversation.tabs.get(conversation.activeId);
    if (!tab?.view) return;
    tab.view.setBounds(this.rect);
  }

  ensure(conversationId) {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 128) throw new Error('会话标识无效');
      if (this.conversations.size >= MAX_OWNERS) throw new Error('浏览器会话记录已达上限，请关闭不用的网页标签');
      conversation = { partition: partitionFor(conversationId), tabs: new Map(), activeId: null, next: 1, revision: 0 };
      this.conversations.set(conversationId, conversation);
    }
    return conversation;
  }

  setShortcuts(value) { this.shortcuts = validatedShortcuts(value); }

  async withConversation(conversationId, callback) {
    this.leases.set(conversationId, (this.leases.get(conversationId) || 0) + 1);
    try { return await callback(); }
    finally {
      const count = this.leases.get(conversationId) - 1;
      if (count) this.leases.set(conversationId, count);
      else this.leases.delete(conversationId);
    }
  }

  reportStorageError(error) {
    if (this.storageError) return;
    this.storageError = true;
    console.error('浏览器标签保存不可用：' + error.message);
    this.window.webContents.send('browser:notice', '浏览器标签保存不可用，请检查本机存储。');
  }

  descriptors() {
    return [...this.conversations].flatMap(([id, conversation]) => conversation.tabs.size ? [{
      id, activeId: conversation.activeId, next: conversation.next,
      pages: [...conversation.tabs.values()].map(({ id, url, title }) => ({ id, url, title })),
    }] : []);
  }

  save() { this.store.schedule(() => this.descriptors()); }

  liveViews() {
    return [...this.conversations].flatMap(([owner, conversation]) => [...conversation.tabs.values()]
      .filter(tab => tab.view).map(tab => ({ owner, conversation, tab })));
  }

  reserveView() {
    const live = this.liveViews();
    if (live.length < this.viewLimit) return;
    const available = live.filter(({ owner, conversation, tab }) =>
      !(this.visible && owner === this.activeConversation && conversation.activeId === tab.id)
      && !this.leases.has(owner));
    const victim = available.sort((a, b) => a.tab.used - b.tab.used)[0];
    if (!victim) throw new Error('浏览器页面正被使用，请关闭一个页面后重试');
    this.releaseView(victim.tab);
  }

  releaseView(tab) {
    const view = tab.view;
    if (!view) return;
    const guestFocused = view.webContents.isFocused?.();
    // 先解绑，使销毁事件区分主动回收与网页自行关闭。
    tab.view = undefined;
    try { this.window.contentView.removeChildView(view); } catch {}
    try { view.webContents.close(); } catch {}
    if (guestFocused) this.window.webContents.focus();
  }

  attachView(conversationId, conversation, tab, options = {}) {
    if (tab.view) return tab.view;
    this.reserveView();
    const view = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
      webPreferences: { ...options.webPreferences, ...browserPreferences(conversation.partition) } });
    tab.view = view;
    const contents = view.webContents;
    // 网页显式录音请求直接拒绝；底层音频探测由应用签名中的 Hardened Runtime 限制。
    contents.session.setPermissionCheckHandler((_contents, permission, _origin, details) =>
      permission !== 'media' || details.mediaType === 'video');
    contents.session.setPermissionRequestHandler((_contents, permission, respond, details) => {
      const types = details.mediaTypes;
      respond(permission !== 'media' || Boolean(types?.includes('video') && !types.includes('audio')));
    });
    contents.session.setDownloadPath(this.downloads);
    contents.setWindowOpenHandler(details => this.openWindow(conversationId, details));
    contents.on('destroyed', () => {
      if (tab.view === view) this.removeTab(conversationId, tab.id);
    });
    contents.on('before-input-event', (event, input) => {
      if (!this.visible || this.activeConversation !== conversationId || conversation.activeId !== tab.id) return;
      const action = browserShortcut(input, this.shortcuts);
      if (!action) return;
      event.preventDefault();
      if (!input.isAutoRepeat) this.window.webContents.send('workspace:shortcut', { action, conversationId });
    });
    const update = () => {
      if (tab.view !== view) return;
      const address = contents.getURL();
      let url;
      try { url = normalizeUrl(address); } catch { return; }
      const title = contents.getTitle().slice(0, 160);
      if (tab.url === url && tab.title === title) return;
      tab.url = url;
      tab.title = title;
      this.emitState(conversationId, true);
    };
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated']) contents.on(event, update);
    return view;
  }

  newTab(conversationId, url, options = {}) {
    const address = url ? normalizeUrl(url) : 'about:blank';
    const conversation = this.ensure(conversationId);
    if (conversation.tabs.size >= MAX_TABS) throw new Error('当前会话的网页标签已达上限');
    const tab = { id: 'tab-' + conversation.next++, url: address, title: '' };
    try { this.attachView(conversationId, conversation, tab, options); }
    catch (error) {
      if (!conversation.tabs.size) this.conversations.delete(conversationId);
      throw error;
    }
    conversation.tabs.set(tab.id, tab);
    this.activate(conversationId, tab.id);
    if (url) tab.view.webContents.loadURL(address).catch(() => {});
    return tab.id;
  }

  openWindow(conversationId, details) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.tabs.size >= MAX_TABS) return { action: 'deny' };
    try { normalizeUrl(details.url); } catch { return { action: 'deny' }; }
    return {
      action: 'allow', outlivesOpener: true,
      // 已创建的 guest 无法事后改权限，必须在 Electron 创建前固定沙箱与同会话 partition。
      overrideBrowserWindowOptions: { webPreferences: browserPreferences(conversation.partition) },
      createWindow: options => this.createWindowTab(conversationId, details, options),
    };
  }

  createWindowTab(conversationId, details, options) {
    // Electron 38 要求返回它预创建的同一个 guest，才能保留 opener、POST 及页面引用。
    const id = this.newTab(conversationId, undefined, options);
    const tab = this.conversations.get(conversationId).tabs.get(id);
    tab.url = normalizeUrl(details.url);
    this.emitState(conversationId, true);
    const contents = this.conversations.get(conversationId).tabs.get(id).view.webContents;
    if (!options.webContents) {
      // 中键等 OpenURLFromTab 路径没有 guest，自定义 createWindow 需负责原始导航。
      const loadOptions = { httpReferrer: details.referrer };
      if (details.postBody) {
        loadOptions.postData = details.postBody.data;
        loadOptions.extraHeaders = 'content-type: ' + details.postBody.contentType + (details.postBody.boundary ? '; boundary=' + details.postBody.boundary : '');
      }
      contents.loadURL(details.url, loadOptions).catch(() => {});
    }
    return contents;
  }

  removeTab(conversationId, id) {
    const conversation = this.conversations.get(conversationId);
    const entry = conversation?.tabs.get(id);
    if (!entry) return;
    conversation.tabs.delete(id);
    if (entry.view) this.releaseView(entry);
    if (conversation.activeId === id) {
      conversation.activeId = conversation.tabs.keys().next().value || null;
      if (conversation.activeId && this.visible && this.activeConversation === conversationId) {
        this.activate(conversationId, conversation.activeId);
      }
    }
    this.emitState(conversationId, true);
    if (!conversation.tabs.size) this.conversations.delete(conversationId);
  }

  activate(conversationId, id) {
    const conversation = this.conversations.get(conversationId);
    const tab = conversation?.tabs.get(id);
    if (!tab) throw new Error('页面不存在');
    const restored = !tab.view;
    const view = this.attachView(conversationId, conversation, tab);
    if (restored) view.webContents.loadURL(tab.url).catch(() => {});
    tab.used = ++this.tick;
    const changed = conversation.activeId !== id;
    conversation.activeId = id;
    if (this.visible && this.activeConversation === conversationId) {
      for (const other of conversation.tabs.values()) {
        if (other.view && other !== tab) this.window.contentView.removeChildView(other.view);
      }
      this.window.contentView.addChildView(view);
      view.setBounds(this.rect);
    }
    if (changed) this.emitState(conversationId, true);
  }

  emitState(conversationId, persist = false) {
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.revision = ++this.revision;
    this.window.webContents.send('browser:changed', {...this.state(conversationId), conversation_id:conversationId});
    if (persist) this.save();
  }

  state(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { revision: this.revision, pages: [], target_id: null, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
    const pages = [...conversation.tabs.values()].map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, active: tab.id === conversation.activeId }));
    return { revision: conversation.revision, pages, target_id: conversation.activeId, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
  }

  handle(conversationId, method, params = {}) {
    const conversation = this.conversations.get(conversationId);
    const tab = () => {
      const entry = conversation?.tabs.get(params.target_id || conversation.activeId);
      if (entry && !entry.view) this.activate(conversationId, entry.id);
      return entry;
    };
    switch (method) {
      case 'status': case 'list_pages': {
        return this.state(conversationId);
      }
      case 'new_page': case 'open_page': this.newTab(conversationId, params.url || 'about:blank'); return this.state(conversationId);
      case 'navigate': {
        const address = normalizeUrl(params.url);
        const current = tab();
        if (!current) this.newTab(conversationId, address);
        else {
          current.url = address;
          current.title = '';
          this.emitState(conversationId, true);
          current.view.webContents.loadURL(address).catch(() => {});
        }
        return this.state(conversationId);
      }
      case 'activate_page': case 'select_page': this.activate(conversationId, params.target_id); return this.state(conversationId);
      case 'close_page': {
        const target = params.target_id || conversation?.activeId;
        this.removeTab(conversationId, target);
        return this.state(conversationId);
      }
      case 'reload': { const current = tab(); if (current) current.view.webContents.reload(); return this.state(conversationId); }
      case 'back': { const current = tab(); if (current && current.view.webContents.navigationHistory.canGoBack()) current.view.webContents.navigationHistory.goBack(); return this.state(conversationId); }
      case 'forward': { const current = tab(); if (current && current.view.webContents.navigationHistory.canGoForward()) current.view.webContents.navigationHistory.goForward(); return this.state(conversationId); }
      case 'release_control': return this.state(conversationId);
      case 'resize': return this.state(conversationId);
      case 'copy_selection': {
        const current = tab();
        if (!current) throw new Error('没有可用的页面');
        return current.view.webContents.executeJavaScript('String(window.getSelection()||"")').then(text => { clipboard.writeText(text); return { copied: true }; });
      }
      case 'stop': {
        for (const entry of conversation?.tabs.values() || []) this.releaseView(entry);
        return { stopped: true, state_preserved: true };
      }
      case 'open_downloads': return shell.openPath(this.downloads).then(() => ({ opened: true }));
      case 'pick_upload': {
        const current = tab();
        if (!current) throw new Error('没有可用的页面');
        return dialog.showOpenDialog({ properties: ['openFile'] }).then(async result => {
          if (result.canceled || !result.filePaths[0]) return { cancelled: true };
          const contents = current.view.webContents;
          if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
          const found = await contents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.querySelector("input[type=file]")', returnByValue: false });
          const objectId = found.result && found.result.objectId;
          if (!objectId) throw new Error('当前页面没有文件上传控件');
          await contents.debugger.sendCommand('DOM.setFileInputFiles', { files: [result.filePaths[0]], objectId });
          return { uploaded: true };
        });
      }
      default: throw new Error('原生浏览器暂不支持：' + method);
    }
  }

  disposeConversation(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    // 先解除归属，避免逐个关闭触发 destroyed 时又激活待销毁的兄弟页面。
    this.conversations.delete(conversationId);
    for (const tab of conversation.tabs.values()) this.releaseView(tab);
    if (this.activeConversation === conversationId) {
      this.activeConversation = null;
      this.visible = false;
    }
  }

  releaseConversation(conversationId) {
    if (!this.conversations.has(conversationId)) return;
    this.disposeConversation(conversationId);
    // 空列表也要有新版本，否则轮询可能保留销毁前的网页标签。
    this.revision++;
    this.emitState(conversationId, true);
  }

  dispose() {
    this.store.flush(() => this.descriptors());
    for (const id of [...this.conversations.keys()]) this.disposeConversation(id);
  }
}

module.exports = { BrowserManager, partitionFor, normalizeUrl };
