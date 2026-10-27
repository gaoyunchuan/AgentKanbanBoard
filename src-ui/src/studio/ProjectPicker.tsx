import { useState } from 'react';
import { Check, Folder, Search, Plus } from 'lucide-react';
import type { BackendProject } from '../types';
export function matchingProjects(projects: BackendProject[], query: string, limit?: number) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = projects.filter(p => words.every(w => `${p.name}\n${p.path}`.toLocaleLowerCase().includes(w)));
  return limit == null ? matches : matches.slice(0, limit);
}
/** One project filter for modal and composer; query is deliberately local. */
export function ProjectPicker({ projects, selected, onSelect, compact = false, onAdd }: {
  projects: BackendProject[]; selected?: string; onSelect: (id: string) => void; compact?: boolean; onAdd?: () => void;
}) {
  const [query, setQuery] = useState('');
  const matching = matchingProjects(projects, query);
  const shown = compact ? matching.slice(0, 5) : matching;
  return <div className={`project-picker ${compact ? 'compact' : ''}`}>
    <div className="picker-search"><Search size={14}/><input autoFocus aria-label={compact ? '检索会话项目' : '搜索任务项目'} placeholder="搜索项目名称或目录" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.stopPropagation()}/>{query && <button aria-label="清除项目搜索" onClick={() => setQuery('')}>×</button>}</div>
    <div className="project-options" role="listbox" aria-label="可选项目">{shown.map(p => <button type="button" key={p.id} role="option" aria-selected={p.id === selected} title={p.path} className={`picker-row ${selected === p.id ? 'chosen' : ''}`} onClick={() => onSelect(p.id)}><Folder size={16}/><span className="grow"><span className="name">{p.name}</span><small>{p.path}</small></span>{selected === p.id && <Check size={14}/>}</button>)}{!shown.length && <p className="empty-search">{query ? '没有匹配项目' : '暂无可选项目'}</p>}</div>
    {compact && matching.length > 5 && <p className="picker-hint">显示前 5 项，共 {matching.length} 项；继续输入以缩小范围</p>}
    {onAdd && <button className="popitem" onClick={onAdd}><Plus size={14}/>添加本地项目</button>}
  </div>;
}
