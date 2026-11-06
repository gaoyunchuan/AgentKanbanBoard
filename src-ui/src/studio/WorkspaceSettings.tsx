import { useState } from 'react';
import { Folder, Globe, Keyboard, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import {
  defaultShortcuts, isShortcut, recommendationLimit, shortcutActions, shortcutDisplay,
  shortcutFromEvent, shortcutLabels, websiteAddress, type RecommendedSite, type ShortcutAction, type Shortcuts,
} from './workspacePreferences';

export const settingsSections = [
  { id: 'connection', label: 'Codex 连接与账户', icon: Settings2 },
  { id: 'excluded', label: '项目排除目录', icon: Folder },
  { id: 'permissions', label: '新任务默认权限', icon: ShieldCheck },
  { id: 'shortcuts', label: '快捷键管理', icon: Keyboard },
  { id: 'recommendations', label: '推荐网址', icon: Globe },
  { id: 'data', label: '本地数据', icon: Settings2 },
] as const;
export type SettingsSection = typeof settingsSections[number]['id'];

export function ShortcutSettings({ shortcuts, onChange }: { shortcuts: Shortcuts; onChange: (value: Shortcuts) => void }) {
  const [recording, setRecording] = useState<ShortcutAction>();
  const [error, setError] = useState('');

  return <section id="settings-shortcuts" className="settings-section">
    <h3><Keyboard size={18}/>快捷键管理</h3>
    <p>点击按键开始录入，按 Esc 取消。⌘W 固定关闭当前标签或会话，也可使用下方配置的快捷键；任务树保持原状。退出应用请用 ⌘Q。</p>
    {shortcutActions.map(action => <div className="workspace-preference-row" key={action}>
      <span>{shortcutLabels[action]}</span>
      <button className="textbtn outlined shortcut-key" aria-label={`修改${shortcutLabels[action]}快捷键`}
        data-shortcut-capture={recording === action ? '' : undefined}
        onClick={() => { setRecording(action); setError(''); }}
        onBlur={() => setRecording(undefined)}
        onKeyDown={event => {
          if (recording !== action || event.key === 'Tab') return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === 'Escape') { setRecording(undefined); return; }
          const value = shortcutFromEvent(event.nativeEvent);
          if (!value) return;
          if (!isShortcut(value, action) || shortcutActions.some(other => other !== action && shortcuts[other] === value)) {
            setError('这个组合键不可用或已被占用，请换一个。');
            return;
          }
          onChange({ ...shortcuts, [action]: value });
          setRecording(undefined);
          setError('');
        }}>
        {recording === action ? '请按快捷键' : <kbd>{shortcutDisplay(shortcuts[action])}</kbd>}
      </button>
    </div>)}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="settings-actions"><button className="textbtn outlined" onClick={() => { onChange(defaultShortcuts); setError(''); }}>恢复默认快捷键</button></div>
  </section>;
}

export function RecommendedSiteSettings({ sites, onChange }: { sites: RecommendedSite[]; onChange: (value: RecommendedSite[]) => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState<number>();
  const [error, setError] = useState('');
  const reset = () => { setEditing(undefined); setName(''); setAddress(''); setError(''); };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    let url: string;
    try { url = websiteAddress(address); }
    catch { setError('请输入有效的 HTTP 或 HTTPS 网址。'); return; }
    if (sites.some((site, index) => index !== editing && site.url === url)) {
      setError('该网址已在推荐列表中。');
      return;
    }
    if (editing === undefined && sites.length >= recommendationLimit) {
      setError(`最多保存 ${recommendationLimit} 条推荐网址。`);
      return;
    }
    const site = { name: name.trim() || new URL(url).hostname, url };
    onChange(editing === undefined ? [...sites, site] : sites.map((value, index) => index === editing ? site : value));
    reset();
  };

  return <section id="settings-recommendations" className="settings-section">
    <h3><Globe size={18}/>推荐网址</h3>
    <p>这里保存的网址会出现在右侧新标签页。</p>
    {sites.map((site, index) => <div className="workspace-preference-row" key={site.url}>
      <div className="workspace-site-label"><strong>{site.name}</strong><small>{site.url}</small></div>
      <button className="textbtn" aria-label={`编辑推荐网址 ${site.name}`} onClick={() => {
        setEditing(index); setName(site.name); setAddress(site.url); setError('');
      }}>编辑</button>
      <button className="iconbtn" aria-label={`移除推荐网址 ${site.name}`} onClick={() => {
        onChange(sites.filter((_, position) => position !== index)); reset();
      }}><Trash2 size={15}/></button>
    </div>)}
    <form onSubmit={save}>
      <label htmlFor="recommended-name">显示名称（可选）</label>
      <input id="recommended-name" maxLength={60} value={name} onChange={event => setName(event.target.value)}/>
      <label htmlFor="recommended-address">网址</label>
      <input id="recommended-address" maxLength={2048} placeholder="https://example.com" value={address} onChange={event => setAddress(event.target.value)}/>
      <div className="settings-actions"><button className="textbtn primary" type="submit" disabled={!address.trim()}>{editing === undefined ? '添加推荐网址' : '保存推荐网址'}</button>
        {editing !== undefined && <button className="textbtn" type="button" onClick={reset}>取消编辑</button>}</div>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}
