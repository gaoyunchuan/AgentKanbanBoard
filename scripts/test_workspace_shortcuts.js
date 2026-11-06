const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { defaults, validatedShortcuts, browserShortcut, bindWorkspaceMenu } = require('../desktop/lib/workspace-shortcuts');

test('原生网页的 Cmd+N 路由到新建会话，其他组合键不触发', () => {
  const input = { type: 'keyDown', key: 'n', meta: true };
  assert.equal(browserShortcut(input, defaults, 'darwin'), 'newConversation');
  for (const extra of [{ shift: true }, { alt: true }, { isComposing: true }, { type: 'keyUp' }]) {
    assert.equal(browserShortcut({ ...input, ...extra }, defaults, 'darwin'), undefined);
  }
});

test('原生网页焦点下，只有无修饰且非组合输入的 F2 触发会话重命名', () => {
  const f2 = { type: 'keyDown', key: 'F2' };
  assert.equal(browserShortcut(f2, defaults, 'darwin'), 'renameConversation');
  for (const modifier of ['shift', 'meta', 'alt', 'control', 'isComposing']) {
    assert.equal(browserShortcut({ ...f2, [modifier]: true }, defaults, 'darwin'), undefined);
  }
  assert.equal(browserShortcut({ ...f2, type: 'keyUp' }, defaults, 'darwin'), undefined);
});

test('已有的三项配置升级后仍生效，补上 Ctrl 加物理键 Backquote', () => {
  const bindings = validatedShortcuts({ sidebar: 'G', newTab: 'T', close: 'W' });
  assert.equal(bindings.sidebar, 'G');
  assert.equal(browserShortcut({ type: 'keyDown', control: true, code: 'Backquote', key: '·' }, bindings, 'darwin'), 'terminal');
  assert.equal(browserShortcut({ type: 'keyDown', control: true, code: 'KeyX', key: 'x' }, bindings, 'darwin'), undefined);
});

test('主窗口将工作区组合键留给页面，菜单兜底只发关闭工作区动作', () => {
  const contents = new EventEmitter();
  const ignored = [], sent = [];
  contents.setIgnoreMenuShortcuts = value => ignored.push(value);
  contents.send = (...args) => sent.push(args);
  const menu = { buildFromTemplate: template => template, setApplicationMenu(template) { this.items = template; } };
  bindWorkspaceMenu(menu, { webContents: contents }, () => defaults, 'darwin');
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'w', meta: true });
  contents.emit('before-input-event', {}, { type: 'keyUp', key: 'w', meta: true });
  assert.deepEqual(ignored, [true, false]);
  const file = menu.items.find(item => item.label === '文件');
  const close = file.submenu.find(item => item.accelerator === 'Command+W');
  close.click();
  assert.deepEqual(sent, [['workspace:shortcut', { action: 'close' }]]);
  assert.equal(menu.items.flatMap(item => item.submenu || []).some(item => item.role === 'quit' && item.accelerator === 'Command+X'), false);
});

test('旧 X 关闭配置失效，Cmd+X 保留原生剪切而不发送工作区关闭', () => {
  const shortcuts = validatedShortcuts({ ...defaults, close: 'X' });
  assert.equal(shortcuts.close, 'W');
  assert.equal(browserShortcut({ type: 'keyDown', key: 'x', meta: true }, shortcuts, 'darwin'), undefined);
  const contents = new EventEmitter(), ignored = [];
  contents.setIgnoreMenuShortcuts = value => ignored.push(value);
  const menu = { buildFromTemplate: template => template, setApplicationMenu(template) { this.items = template; } };
  bindWorkspaceMenu(menu, { webContents: contents }, () => shortcuts, 'darwin');
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'x', meta: true });
  assert.deepEqual(ignored, [false]);
  const edit = menu.items.find(item => item.label === '编辑');
  assert.equal(edit.submenu.some(item => item.role === 'cut'), true);
  assert.equal(edit.submenu.some(item => item.accelerator === 'Command+X'), false);
});

test('Cmd+W 固定关闭工作区，自定义关闭键不能让它退回关闭应用', () => {
  for (const shortcuts of [defaults, { ...defaults, close: 'G' }]) {
    assert.equal(browserShortcut({ type: 'keyDown', key: 'w', code: 'KeyW', meta: true }, shortcuts, 'darwin'), 'close');
    assert.equal(browserShortcut({ type: 'keyDown', key: 'w', code: 'KeyW', control: true }, shortcuts, 'linux'), 'close');
    for (const extra of [{ shift: true }, { alt: true }, { isComposing: true }, { type: 'keyUp' }]) {
      assert.equal(browserShortcut({ type: 'keyDown', key: 'w', meta: true, ...extra }, shortcuts, 'darwin'), undefined);
    }
  }
});

test('原生 Cmd+W 菜单只发送关闭工作区，不关闭主窗口', () => {
  const contents = new EventEmitter(), sent = [], ignored = [];
  contents.setIgnoreMenuShortcuts = value => ignored.push(value);
  contents.send = (...args) => sent.push(args);
  const menu = { buildFromTemplate: template => template, setApplicationMenu(template) { this.items = template; } };
  bindWorkspaceMenu(menu, { webContents: contents }, () => ({ ...defaults, close: 'G' }), 'darwin');
  contents.emit('before-input-event', {}, { type: 'keyDown', key: 'w', meta: true });
  assert.deepEqual(ignored, [true]);
  const close = menu.items.flatMap(item => item.submenu || []).find(item => item.accelerator === 'Command+W');
  assert.notEqual(close.role, 'close');
  close.click();
  assert.deepEqual(sent, [['workspace:shortcut', { action: 'close' }]]);
});

test('原生网页拥有焦点时菜单关闭携带会话归属，不能误退回任务树', () => {
  const contents = new EventEmitter(), sent = [];
  contents.send = (...args) => sent.push(args);
  const menu = { buildFromTemplate: template => template, setApplicationMenu(template) { this.items = template; } };
  let focused = 'conversation-one';
  bindWorkspaceMenu(menu, { webContents: contents }, () => defaults, 'darwin', () => focused);
  const close = menu.items.flatMap(item => item.submenu || []).find(item => item.accelerator === 'Command+W');
  close.click();
  focused = undefined;
  close.click();
  assert.deepEqual(sent, [
    ['workspace:shortcut', { action: 'close', conversationId: 'conversation-one' }],
    ['workspace:shortcut', { action: 'close' }],
  ]);
});

test('原生网页的 Cmd+逗号打开设置，其他组合不触发', () => {
  const input = { type: 'keyDown', key: ',', meta: true };
  assert.equal(browserShortcut(input, defaults, 'darwin'), 'settings');
  for (const extra of [{ shift: true }, { alt: true }, { control: true }, { isComposing: true }, { type: 'keyUp' }]) {
    assert.equal(browserShortcut({ ...input, ...extra }, defaults, 'darwin'), undefined);
  }
});
