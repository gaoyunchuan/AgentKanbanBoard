const defaults = { sidebar: 'B', newTab: 'T', close: 'W', terminal: 'Ctrl+Backquote' };
const reserved = new Set(['1', '2', 'A', 'C', 'H', 'M', 'N', 'Q', 'V', 'W', 'X', 'Z', 'Shift+Z']);

function validatedShortcuts(value) {
  const bindings = Object.fromEntries(Object.keys(defaults).map(action => [action, value?.[action] ?? defaults[action]]));
  const keys = Object.values(bindings);
  return new Set(keys).size === keys.length && Object.entries(bindings).every(([action, key]) => key === 'W' && action === 'close'
    || key === 'Ctrl+Backquote' || typeof key === 'string' && /^(Alt\+)?(Shift\+)?[A-Z0-9]$/.test(key) && !reserved.has(key))
    ? bindings : defaults;
}

function browserShortcut(input, shortcuts, platform = process.platform) {
  if (input.type !== 'keyDown') return;
  // 原生网页有独立键盘焦点，将固定的会话快捷键转回主窗口。
  if (input.key === 'F2' && !input.isComposing && !input.control && !input.meta && !input.alt && !input.shift) {
    return 'renameConversation';
  }
  // 固定物理键，兼容中文布局上显示的中点。
  if (input.control && !input.meta && !input.alt && !input.shift && (input.code === 'Backquote'
      || (!input.code || input.code === 'Unidentified') && ['`', '·'].includes(input.key))) {
    return Object.keys(shortcuts).find(action => shortcuts[action] === 'Ctrl+Backquote');
  }
  if (input.isComposing || (platform === 'darwin' ? !input.meta || input.control : !input.control || input.meta)) return;
  if (platform === 'darwin' && input.key === ',' && !input.alt && !input.shift) return 'settings';
  const key = /^[a-z0-9]$/i.test(input.key) ? input.key.toUpperCase()
    : input.alt && /^(Key[A-Z]|Digit[0-9])$/.test(input.code) ? input.code.slice(-1) : '';
  const combo = (input.alt ? 'Alt+' : '') + (input.shift ? 'Shift+' : '') + key;
  if (platform === 'darwin' && combo === 'N') return 'newConversation';
  // 原生 Cmd+W 曾直接关闭主窗口；固定转为工作区关闭，不随自定义绑定恢复退出行为。
  if (combo === 'W') return 'close';
  return Object.keys(shortcuts).find(action => shortcuts[action] === combo);
}

function bindWorkspaceMenu(Menu, window, shortcuts, platform = process.platform, focusedConversation = () => undefined) {
  if (platform !== 'darwin') return;
  const contents = window.webContents;
  // 主窗口仍通过 DOM 识别焦点和录键状态，只抑制该键对应的原生菜单处理。
  contents.on('before-input-event', (_event, input) => {
    contents.setIgnoreMenuShortcuts(Boolean(browserShortcut(input, shortcuts(), platform)));
  });
  contents.on('blur', () => contents.setIgnoreMenuShortcuts(false));
  const closeWorkspace = () => {
    // 独立网页拥有原生焦点时，主页面 activeElement 仍可能指向聊天输入框。
    const conversationId = focusedConversation();
    contents.send('workspace:shortcut', { action: 'close', ...(conversationId ? { conversationId } : {}) });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' },
      { role: 'unhide' }, { type: 'separator' }, { role: 'quit', accelerator: 'Command+Q' },
    ] },
    { label: '文件', submenu: [{ label: '关闭当前标签或会话', accelerator: 'Command+W',
      click: closeWorkspace }] },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
}

module.exports = { defaults, validatedShortcuts, browserShortcut, bindWorkspaceMenu };
