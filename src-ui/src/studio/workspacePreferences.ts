export const shortcutLabels = {
  sidebar: '切换左侧边栏',
  newTab: '新建右侧标签',
  close: '关闭当前标签或会话',
  terminal: '新建右侧终端',
} as const;
export type ShortcutAction = keyof typeof shortcutLabels;
export type Shortcuts = Record<ShortcutAction, string>;
export const defaultShortcuts: Shortcuts = { sidebar: 'B', newTab: 'T', close: 'W', terminal: 'Ctrl+Backquote' };
export const shortcutActions = Object.keys(shortcutLabels) as ShortcutAction[];
export const shortcutStorage = 'akb.workspace.shortcuts.v1';
const siteStorage = 'akb.workspace.recommended-sites.v1';
export const recommendationLimit = 20;
export type RecommendedSite = { name: string; url: string };

function readLocal(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

export function writePreference(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function isShortcut(value: unknown, action: ShortcutAction): value is string {
  return value === 'W' && action === 'close' || value === 'Ctrl+Backquote' || typeof value === 'string' && /^(?:Alt\+)?(?:Shift\+)?[A-Z0-9]$/.test(value)
    && !['1', '2', 'A', 'C', 'H', 'M', 'N', 'Q', 'V', 'W', 'X', 'Z', 'Shift+Z'].includes(value);
}

export function readShortcuts(): Shortcuts {
  const saved = readLocal(shortcutStorage) as Partial<Shortcuts> | null;
  const result = { ...defaultShortcuts };
  for (const action of shortcutActions) {
    const value = saved?.[action];
    if (isShortcut(value, action)) result[action] = value;
  }
  return new Set(Object.values(result)).size === shortcutActions.length ? result : { ...defaultShortcuts };
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === 'Backquote'
      || (!event.code || event.code === 'Unidentified') && ['`', '·'].includes(event.key))) return 'Ctrl+Backquote';
  if (!(event.metaKey || event.ctrlKey) || event.metaKey && event.ctrlKey || event.isComposing) return;
  const key = /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase()
    : event.altKey && /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code.slice(-1) : '';
  if (key) return `${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
}

export function shortcutDisplay(value: string) {
  if (value === 'Ctrl+Backquote') return 'Ctrl + ·';
  return '⌘' + value.replace('Alt+', '⌥').replace('Shift+', '⇧');
}

export function websiteAddress(input: string): string {
  const value = input.trim();
  if (!value || value.length > 2048) throw new Error('请输入不超过 2048 字符的网址');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
    throw new Error('请输入不含账号密码的 HTTP 或 HTTPS 网址');
  }
  return url.href;
}

export function readRecommendations(): RecommendedSite[] {
  const saved = readLocal(siteStorage);
  if (!Array.isArray(saved)) return [];
  return saved.slice(0, recommendationLimit).flatMap(site => {
    if (typeof site?.name !== 'string' || typeof site?.url !== 'string') return [];
    try { return [{ name: site.name.slice(0, 60), url: websiteAddress(site.url) }]; }
    catch { return []; }
  });
}

export function saveRecommendations(sites: RecommendedSite[]) {
  writePreference(siteStorage, sites);
}
