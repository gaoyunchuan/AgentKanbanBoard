import { useState } from 'react';
import { ArrowUpRight, Folder, GitPullRequest, Globe, Terminal } from 'lucide-react';
import type { DockKind } from './dockTabs';
import { websiteAddress, type RecommendedSite } from './workspacePreferences';

const tools = [
  { kind: 'diff', label: '变更', icon: GitPullRequest },
  { kind: 'terminal', label: '终端', icon: Terminal },
  { kind: 'files', label: '文件', icon: Folder },
  { kind: 'browser', label: '新建页面', icon: Globe },
] as const;

export function DockLauncher({ sites, open }: {
  sites: RecommendedSite[];
  open: (kind: Exclude<DockKind, 'launcher'>, url?: string) => void;
}) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  return <div className="dock-launcher">
    <form className="dock-address" onSubmit={event => {
      event.preventDefault();
      try { open('browser', websiteAddress(address)); }
      catch { setError('请输入有效的 HTTP 或 HTTPS 网址。'); }
    }}>
      <Globe size={15}/>
      <input aria-label="输入网址" placeholder="输入网址" maxLength={2048} value={address} onChange={event => { setAddress(event.target.value); setError(''); }}/>
      <button className="iconbtn" aria-label="打开网址" disabled={!address.trim()}><ArrowUpRight size={16}/></button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <h3>工具</h3>
    <div className="dock-launcher-tools">{tools.map(({ kind, label, icon: Icon }) =>
      <button key={kind} onClick={() => open(kind)}><Icon size={16}/>{label}<ArrowUpRight className="dock-launch-arrow" size={13}/></button>)}</div>
    <h3>推荐</h3>
    {sites.length ? <div className="dock-launcher-sites">{sites.map(site =>
      <button key={site.url} title={site.url} onClick={() => open('browser', site.url)}><Globe size={19}/><span>{site.name}</span></button>)}</div>
      : <p className="dock-launcher-empty">可以在「设置 → 推荐网址」添加常用网站。</p>}
  </div>;
}
