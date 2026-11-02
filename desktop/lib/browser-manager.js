// 每个会话一组 WebContentsView（原生 Chromium），由一个渲染进程上报面板矩形来摆放。
const { WebContentsView, clipboard, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.length > 8192) throw new Error('仅支持无凭据的 HTTP/HTTPS 地址');
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
    this.rect = options.rect || { x: 0, y: 0, width: 0, height: 0 };
    this.downloads = options.downloads || path.join(process.env.HOME || '', '.codex-kanban', 'downloads');
    fs.mkdirSync(this.downloads, { recursive: true });
    this.window.on('resize', () => this.layout());
  }

  downloadPath() { return this.downloads; }
  activeContents(conversationId) {
    const conversation = this.conversations.get(conversationId);
    const tab = conversation && conversation.tabs.get(conversation.activeId);
    return tab ? tab.view.webContents : null;
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

  hide() {
    // 网页激活可来自 Agent；只有可见面板的矩形上报拥有原生视图显示权。
    this.visible = false;
    for (const conversation of this.conversations.values()) for (const tab of conversation.tabs.values()) {
      try { this.window.contentView.removeChildView(tab.view); } catch {}
    }
  }

  activateConversation(conversationId) {
    const conversation = this.ensure(conversationId);
    if (!conversation.tabs.size) this.newTab(conversationId, 'about:blank');
    else this.activate(conversationId, conversation.activeId);
  }

  layout() {
    if (!this.visible) return;
    const conversation = this.activeConversation && this.conversations.get(this.activeConversation);
    if (!conversation) return;
    const tab = conversation.tabs.get(conversation.activeId);
    if (!tab) return;
    tab.view.setBounds(this.rect);
  }

  ensure(conversationId) {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      conversation = { partition: partitionFor(conversationId), tabs: new Map(), activeId: null, next: 1, revision: 0 };
      this.conversations.set(conversationId, conversation);
    }
    return conversation;
  }

  newTab(conversationId, url, options = {}) {
    const conversation = this.ensure(conversationId);
    const id = 'tab-' + conversation.next++;
    const view = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}), webPreferences: { ...options.webPreferences, ...browserPreferences(conversation.partition) } });
    view.webContents.session.setDownloadPath(this.downloads);
    conversation.tabs.set(id, { id, view, url: 'about:blank', title: '' });
    view.webContents.setWindowOpenHandler(details => this.openWindow(conversationId, details));
    view.webContents.on('destroyed', () => this.removeTab(conversationId, id));
    const update = () => {
      const tab = conversation.tabs.get(id);
      if (!tab) return;
      tab.url = tab.view.webContents.getURL(); tab.title = tab.view.webContents.getTitle();
      this.emitState(conversationId);
    };
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) view.webContents.on(event, update);
    this.activate(conversationId, id);
    if (url) view.webContents.loadURL(normalizeUrl(url)).catch(() => {});
    return id;
  }

  openWindow(conversationId, details) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { action: 'deny' };
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
    const entry = conversation && conversation.tabs.get(id);
    if (!entry) return;
    try { this.window.contentView.removeChildView(entry.view); } catch {}
    conversation.tabs.delete(id);
    if (conversation.activeId === id) {
      const next = conversation.tabs.keys().next().value;
      conversation.activeId = next || null;
      if (next) this.activate(conversationId, next);
    }
    this.emitState(conversationId);
  }

  activate(conversationId, id) {
    const conversation = this.ensure(conversationId);
    if (!conversation.tabs.has(id)) throw new Error('页面不存在');
    for (const other of conversation.tabs.values()) { try { this.window.contentView.removeChildView(other.view); } catch {} }
    const tab = conversation.tabs.get(id);
    if (this.visible && this.activeConversation === conversationId) this.window.contentView.addChildView(tab.view);
    conversation.activeId = id;
    tab.view.setBounds(this.rect);
    this.emitState(conversationId);
  }

  emitState(conversationId) {
    const conversation=this.conversations.get(conversationId);
    if(conversation) conversation.revision++;
    this.window.webContents.send('browser:changed', {...this.state(conversationId), conversation_id:conversationId});
  }

  state(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { pages: [], target_id: null, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
    const pages = [...conversation.tabs.values()].map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, active: tab.id === conversation.activeId }));
    return { revision: conversation.revision, pages, target_id: conversation.activeId, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
  }

  handle(conversationId, method, params = {}) {
    const conversation = this.ensure(conversationId);
    const tab = () => conversation.tabs.get(conversation.activeId);
    switch (method) {
      case 'status': case 'list_pages': {
        return this.state(conversationId);
      }
      case 'new_page': case 'open_page': this.newTab(conversationId, params.url || 'about:blank'); return this.state(conversationId);
      case 'navigate': { const current = tab(); if (current) current.view.webContents.loadURL(normalizeUrl(params.url)).catch(() => {}); else this.newTab(conversationId, params.url || 'about:blank'); return this.state(conversationId); }
      case 'activate_page': case 'select_page': this.activate(conversationId, params.target_id); return this.state(conversationId);
      case 'close_page': {
        const target = params.target_id || conversation.activeId;
        const entry = conversation.tabs.get(target);
        this.removeTab(conversationId, target);
        if (entry) { try { entry.view.webContents.close(); } catch {} }
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
      case 'stop': this.disposeConversation(conversationId); return { stopped: true, state_preserved: true };
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
    for (const tab of conversation.tabs.values()) { try { this.window.contentView.removeChildView(tab.view); } catch {} try { tab.view.webContents.close(); } catch {} }
    if (this.activeConversation === conversationId) this.activeConversation = null;
  }

  dispose() { for (const id of [...this.conversations.keys()]) this.disposeConversation(id); }
}

module.exports = { BrowserManager, partitionFor, normalizeUrl };
