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

class BrowserManager {
  constructor(window, options = {}) {
    this.window = window;
    this.conversations = new Map();
    this.activeConversation = null;
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
    this.rect = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const conversation = this.conversations.get(conversationId);
    if (conversation && conversation.activeId) this.activate(conversationId, conversation.activeId);
  }

  hide() {
    const conversation = this.activeConversation && this.conversations.get(this.activeConversation);
    const tab = conversation && conversation.tabs.get(conversation.activeId);
    if (tab) { try { this.window.contentView.removeChildView(tab.view); } catch {} }
  }

  layout() {
    const conversation = this.activeConversation && this.conversations.get(this.activeConversation);
    if (!conversation) return;
    const tab = conversation.tabs.get(conversation.activeId);
    if (!tab) return;
    tab.view.setBounds(this.rect);
  }

  ensure(conversationId) {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      conversation = { partition: partitionFor(conversationId), tabs: new Map(), activeId: null, next: 1 };
      this.conversations.set(conversationId, conversation);
    }
    return conversation;
  }

  newTab(conversationId, url) {
    const conversation = this.ensure(conversationId);
    const id = 'tab-' + conversation.next++;
    const view = new WebContentsView({ webPreferences: { partition: conversation.partition, contextIsolation: true, sandbox: true } });
    view.webContents.session.setDownloadPath(this.downloads);
    conversation.tabs.set(id, { id, view, url: 'about:blank', title: '' });
    const update = () => {
      const tab = conversation.tabs.get(id);
      if (!tab) return;
      tab.url = tab.view.webContents.getURL(); tab.title = tab.view.webContents.getTitle();
      if (conversation.activeId === id && this.activeConversation === conversationId) this.window.webContents.send('browser:changed', this.state(conversationId));
    };
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) view.webContents.on(event, update);
    this.activate(conversationId, id);
    if (url) view.webContents.loadURL(normalizeUrl(url)).catch(() => {});
    return id;
  }

  activate(conversationId, id) {
    const conversation = this.ensure(conversationId);
    if (!conversation.tabs.has(id)) throw new Error('页面不存在');
    for (const other of conversation.tabs.values()) { try { this.window.contentView.removeChildView(other.view); } catch {} }
    const tab = conversation.tabs.get(id);
    this.window.contentView.addChildView(tab.view);
    conversation.activeId = id;
    tab.view.setBounds(this.rect);
    this.activeConversation = conversationId;
  }

  state(conversationId) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return { pages: [], target_id: null, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
    const pages = [...conversation.tabs.values()].map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url, active: tab.id === conversation.activeId }));
    return { pages, target_id: conversation.activeId, stream_url: null, human_control: false, state_path: null, input_interrupted: false };
  }

  handle(conversationId, method, params = {}) {
    const conversation = this.ensure(conversationId);
    const tab = () => conversation.tabs.get(conversation.activeId);
    switch (method) {
      case 'status': case 'list_pages': {
        if (!conversation.tabs.size) this.newTab(conversationId, 'about:blank');
        return this.state(conversationId);
      }
      case 'new_page': case 'open_page': this.newTab(conversationId, params.url || 'about:blank'); return this.state(conversationId);
      case 'navigate': { const current = tab(); if (current) current.view.webContents.loadURL(normalizeUrl(params.url)).catch(() => {}); else this.newTab(conversationId, params.url || 'about:blank'); return this.state(conversationId); }
      case 'activate_page': case 'select_page': this.activate(conversationId, params.target_id); return this.state(conversationId);
      case 'close_page': {
        const target = params.target_id || conversation.activeId;
        const entry = conversation.tabs.get(target);
        if (entry) { try { this.window.contentView.removeChildView(entry.view); } catch {} try { entry.view.webContents.close(); } catch {} conversation.tabs.delete(target); }
        if (conversation.activeId === target) { const next = conversation.tabs.keys().next().value; conversation.activeId = next || null; if (next) this.activate(conversationId, next); }
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
    for (const tab of conversation.tabs.values()) { try { this.window.contentView.removeChildView(tab.view); } catch {} try { tab.view.webContents.close(); } catch {} }
    this.conversations.delete(conversationId);
    if (this.activeConversation === conversationId) this.activeConversation = null;
  }

  dispose() { for (const id of [...this.conversations.keys()]) this.disposeConversation(id); }
}

module.exports = { BrowserManager, partitionFor, normalizeUrl };
