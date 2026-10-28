import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, Filter, RotateCcw, Search } from 'lucide-react';
import { useStudio } from './context';
import { StatusIcon } from './TaskStatusIcon';
import { emptyTaskQuery, TASK_STATES, type TaskQuery } from './taskFilters';

export function TaskFilters() {
  const s = useStudio(), q = s.taskQuery;
  const [menu, setMenu] = useState<'states'|'projects'|null>(null);
  const [projectSearch, setProjectSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const change = (patch: Partial<TaskQuery>) => s.setTaskQuery(v => ({...v, ...patch, page: 0, scroll: 0, collapsed: []}));
  const projectOptions = [{id:'__none__', name:'未设置项目', path:''}, ...s.data.projects];
  for (const id of q.projects) if (!projectOptions.some(p=>p.id===id)) projectOptions.push({id,name:'已隐藏或不可用的项目',path:id});
  const projects = projectOptions.filter(p => `${p.name} ${p.path}`.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()));
  return <div className="task-filter-bar" ref={root}>
    <div className="task-filter-line">
      <div className="searchbox"><Search size={14}/><input aria-label="搜索全局任务" placeholder="搜索任务树标题或上下文" value={q.text} onChange={e=>change({text:e.target.value})}/></div>
      <div className="filter-anchor"><button className="textbtn outlined" aria-label="筛选任务状态" aria-expanded={menu==='states'} onClick={()=>setMenu(menu==='states'?null:'states')}><Filter size={14}/>{q.states.length===4?'全部状态':q.states.length?`${q.states.length} 种状态`:'未选择状态'}<ChevronDown size={12}/></button>
        {menu==='states'&&<div className="filter-popover" role="group" aria-label="多选任务状态"><div className="filter-actions"><button onClick={()=>change({states:TASK_STATES.map(([id])=>id)})}>全选</button><button onClick={()=>change({states:[]})}>全不选</button></div>{TASK_STATES.map(([id,label])=><label key={id}><input type="checkbox" checked={q.states.includes(id)} onChange={()=>change({states:q.states.includes(id)?q.states.filter(x=>x!==id):[...q.states,id]})}/><StatusIcon status={id}/>{label}</label>)}</div>}
      </div>
      <label className="time-filter"><span className="sr-only">按更新时间筛选</span><select aria-label="按更新时间筛选" value={q.updated} onChange={e=>change({updated:e.target.value as TaskQuery['updated']})}><option value="all">全部更新时间</option><option value="day">最近 24 小时</option><option value="week">周视图 · 最近 7 天</option><option value="month">最近 30 天</option></select></label>
      <div className="filter-anchor"><button className="textbtn outlined" aria-label="筛选任务项目" aria-expanded={menu==='projects'} onClick={()=>setMenu(menu==='projects'?null:'projects')}>{q.projects.length?`${q.projects.length} 个项目`:'全部项目'}<ChevronDown size={12}/></button>
        {menu==='projects'&&<div className="filter-popover project-filter" role="group" aria-label="多选任务项目"><input aria-label="搜索筛选项目" placeholder="搜索项目名称或路径" value={projectSearch} onChange={e=>setProjectSearch(e.target.value)}/><button className="textbtn" onClick={()=>change({projects:[]})}>全部项目（不限）</button><div className="filter-options">{projects.map(p=><label key={p.id} title={p.path}><input type="checkbox" checked={q.projects.includes(p.id)} onChange={()=>change({projects:q.projects.includes(p.id)?q.projects.filter(x=>x!==p.id):[...q.projects,p.id]})}/><span className="truncate">{p.name}</span></label>)}{!projects.length&&<p className="note">没有匹配项目</p>}</div></div>}
      </div>
    </div>
    <div className="task-filter-line secondary"><span className="note grow">{q.updated==='week'?'周视图按最近 168 小时的实际任务变更筛选。':'条件取交集；仅补齐命中任务的祖先。'}</span><button className="textbtn" onClick={()=>s.setTaskQuery(v=>({...v,collapsed:[],page:0,scroll:0}))}><ChevronsUpDown size={14}/>全部展开</button><button className="textbtn" onClick={()=>s.setTaskQuery(v=>({...v,collapsed:s.data.tasks.filter(t=>s.data.tasks.some(x=>x.parent_id===t.id)).map(t=>t.id),page:0,scroll:0}))}><ChevronsDownUp size={14}/>全部折叠</button><button className="textbtn" onClick={()=>{s.setTaskQuery(emptyTaskQuery());setMenu(null);setProjectSearch('')}}><RotateCcw size={14}/>重置筛选</button></div>
  </div>;
}
