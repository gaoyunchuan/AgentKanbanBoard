import { useRef, useState } from 'react';
import { Check, Folder, Search, Plus } from 'lucide-react';
import type { BackendProject } from '../types';
import { useProjectNavigation } from './useProjectNavigation';
export function matchingProjects<T extends {name: string; path: string}>(projects: T[], query: string, limit?: number) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = projects.filter(p => words.every(w => `${p.name}\n${p.path}`.toLocaleLowerCase().includes(w)));
  return limit == null ? matches : matches.slice(0, limit);
}
/** 任务和会话选择器只展示项目名；实际路径由项目管理展示，仍支持按目录检索。 */
export function ProjectPicker({ projects, selected, onSelect, compact = false, onAdd, onClose, emptyLabel }: {
  projects: BackendProject[]; selected?: string; onSelect: (id: string) => void; compact?: boolean; onAdd?: () => void; onClose?: () => void; emptyLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const matching = matchingProjects(projects, query);
  const matches = compact ? matching.slice(0, 5) : matching;
  const shown = emptyLabel && !query.trim() ? [{id:'', name:emptyLabel, path:''}, ...matches] : matches;
  const navigation = useProjectNavigation(shown.map(p => p.id), onSelect, selected, onClose);
  return <div className={`project-picker ${compact ? 'compact' : ''}`} onKeyDown={e => {if(e.key==='Escape'&&onClose){e.preventDefault();e.stopPropagation();onClose();}}}>
    <div className="picker-search"><Search size={14}/><input ref={search} autoFocus aria-label={compact ? '检索会话项目' : '搜索任务项目'} placeholder="搜索项目名称或目录" value={query} onChange={e => {setQuery(e.target.value);navigation.reset();}} {...navigation.inputProps}/>{query && <button aria-label="清除项目搜索" onClick={() => {setQuery('');navigation.reset();search.current?.focus();}}>×</button>}</div>
    <div className="project-options" role="listbox" id={navigation.listId} aria-label="可选项目">{shown.map(p => <button type="button" key={p.id} role="option" id={navigation.optionId(p.id)} data-highlighted={navigation.active === p.id} onMouseMove={() => navigation.setHighlighted(p.id)} onFocus={() => navigation.setHighlighted(p.id)} onKeyDown={navigation.onKeyDown} aria-selected={p.id === selected} className={`picker-row ${selected === p.id ? 'chosen' : ''}`} onClick={() => onSelect(p.id)}><Folder size={16}/><span className="grow name">{p.name}</span>{selected === p.id && <Check size={14}/>}</button>)}{!shown.length && <p className="empty-search">{query ? '没有匹配项目' : '暂无可选项目'}</p>}</div>
    {compact && matching.length > 5 && <p className="picker-hint">显示前 5 项，共 {matching.length} 项；继续输入以缩小范围</p>}
    {onAdd && <button className="popitem" onClick={onAdd}><Plus size={14}/>添加本地项目</button>}
  </div>;
}
