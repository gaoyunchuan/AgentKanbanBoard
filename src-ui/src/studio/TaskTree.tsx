import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Pin, ChevronDown, ChevronRight, MessageSquare, Clock,  Link, ListTree, Settings2, Trash2, ArrowUpRight } from 'lucide-react';
import { useStudio } from './context';
import { ancestors, flattenedTasks, taskConversations, taskLabel, type StudioTask } from './model';
import { HoverInfo } from './components';
import { StatusIcon } from './TaskStatusIcon';
import { TaskFilters } from './TaskFilterBar';
import { queryTasks } from './taskFilters';

type Menu = { task: StudioTask; x: number; y: number; status?: boolean };
export function TaskMenu({ menu, close }: { menu: Menu; close: () => void }) {
  const s = useStudio(), ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const pointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') {e.preventDefault(); close();} };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [close]);
  const act = (fn: () => void) => { close(); fn(); };
  const t = menu.task;
  return createPortal(<div className="studio context-menu-layer"><div ref={ref} className="inline-menu task-context-menu" role="menu" aria-label={menu.status ? `${t.title} 状态菜单` : `${t.title} 任务菜单`} style={{ left: Math.min(menu.x, window.innerWidth - 252), top: Math.max(12, Math.min(menu.y, window.innerHeight - (menu.status ? 220 : 330))) }}>
    {menu.status ? ([['todo','待办'],['in_progress','进行中'],['completed','已完成'],['cancelled','已取消']] as const).map(([value,label]) => <button role="menuitemradio" aria-checked={t.status === value} className="popitem" key={value} onClick={() => act(() => s.changeTaskState(t,value))}><StatusIcon status={value}/>{label}{t.status===value&&<span className="grow checkmark">✓</span>}</button>) : <>
      <button role="menuitem" className="popitem" onClick={() => act(() => s.openTask(t.id))}><MessageSquare size={15}/>打开任务会话</button>
      <button role="menuitem" className="popitem" onClick={() => act(() => s.openDialog({kind:'createTask',parent:t.id}))}><ListTree size={15}/>添加子任务</button>
      <button role="menuitem" className="popitem" onClick={() => act(() => s.openDialog({kind:'dependencies',task:t.id}))}><Link size={15}/>设置前置任务</button>
      <button role="menuitem" className="popitem" onClick={() => act(() => s.inspectTask(t.id,'properties'))}><Settings2 size={15}/>属性与设置</button>
      {!t.parent_id && <button role="menuitem" className="popitem" onClick={() => act(() => {void s.command('update_task',{task_id:t.id,patch:{pinned:!t.pinned},before:{pinned:t.pinned}}).catch(()=>{});})}><Pin size={15}/>{t.pinned?'取消置顶任务':'置顶任务'}</button>}
      <div className="popline"/><button role="menuitem" className="popitem danger" onClick={() => act(() => s.openDialog({kind:'deleteTask',task:t.id}))}><Trash2 size={15}/>删除任务</button>
    </>}
  </div></div>,document.body);
}
export function TaskTree() {
  const s = useStudio();
  const query=s.taskQuery.text, page=s.taskQuery.page;
  const collapsed=useMemo(()=>new Set(s.taskQuery.collapsed),[s.taskQuery.collapsed]);
  const setCollapsed=(fn:(v:Set<string>)=>Set<string>)=>s.setTaskQuery(q=>({...q,collapsed:[...fn(new Set(q.collapsed))]}));
  const setPage=(page:number)=>s.setTaskQuery(q=>({...q,page,scroll:0}));
  const pageRef=useRef<HTMLElement>(null), [now,setNow]=useState(Date.now);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer)},[]);
  const [menu,setMenu] = useState<Menu>();
  const [editing,setEditing] = useState<{id:string; text:string; original:string}>();
  const editingRef=useRef(editing);editingRef.current=editing;
  const editInput = useRef<HTMLInputElement>(null), clickTimer=useRef<ReturnType<typeof setTimeout>>();
  const editLock = useRef(false), indented = useRef<string>(), mounted=useRef(true);
  const {rows, matched}=useMemo(()=>queryTasks(s.data.tasks,s.taskQuery,now),[s.data.tasks,s.taskQuery,now]);
  const lastPage=Math.max(0,Math.ceil(rows.length/200)-1), currentPage=Math.min(page,lastPage);
  useLayoutEffect(()=>{if(pageRef.current)pageRef.current.scrollTop=s.taskQuery.scroll;},[s.taskQuery.scroll]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearTimeout(clickTimer.current)}},[]);
  useEffect(()=>{if(editing){editInput.current?.focus();editInput.current?.select()}},[editing?.id]);
  const edit = (t:StudioTask) => {clearTimeout(clickTimer.current);indented.current=undefined;s.inspectTask(t.id);setEditing({id:t.id,text:t.title,original:t.title})};
  const persistTitle = async (keep = false) => {
    const captured=editingRef.current;if(!captured)return;
    const text=captured.text.trim();if(!text)throw new Error('任务名称不能为空');
    if(text!==captured.original)await s.command('update_task',{task_id:captured.id,patch:{title:text},before:{title:captured.original}});
    if(mounted.current)setEditing(current=>current?.id===captured.id?(keep?{...current,original:text}:undefined):current);
  };
  const editKey = async (e:React.KeyboardEvent<HTMLInputElement>,t:StudioTask) => {
    if(e.nativeEvent.isComposing)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setEditing(undefined);return;}
    if(!['Enter','Tab'].includes(e.key))return;
    e.preventDefault();e.stopPropagation();if(editLock.current)return;editLock.current=true;
    try {
      await persistTitle(true);
      if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)) {
        const created=await s.command<{task_id:string}>('create_task',{title:'新任务',parent_id:t.parent_id??null,after_id:t.id});
        s.inspectTask(created.task_id);setEditing({id:created.task_id,text:'新任务',original:'新任务'});
      } else if(e.key==='Tab') {
        if(!e.shiftKey&&indented.current===t.id)return;
        const index=rows.findIndex(x=>x.task.id===t.id), previous=rows[index-1]?.task;
        // The immediate visible predecessor becomes the parent. After indentation
        // it IS the parent, so another Tab cannot indent the same task again.
        const parents=ancestors(s.data.tasks,t.id);
        const target=e.shiftKey ? parents[parents.length-1]?.parent_id??null : previous?.id;
        if(e.shiftKey && !t.parent_id || target===undefined || target===t.parent_id)return;
        await s.command('move_task',{task_id:t.id,parent_id:target,expected_parent_id:t.parent_id??null});
        indented.current=e.shiftKey?undefined:t.id;
        if(target)setCollapsed(current=>{const next=new Set(current);next.delete(target);return next});
        requestAnimationFrame(()=>editInput.current?.focus());
      } else setEditing(undefined);
    }catch(e){s.notify(String(e));}finally{editLock.current=false;}
  };
  const openMenu=(e:React.MouseEvent,t:StudioTask,status=false)=>{e.preventDefault();e.stopPropagation();clearTimeout(clickTimer.current);setMenu({task:t,x:e.clientX,y:e.clientY,status})};
  const selectAndOpen=(t:StudioTask)=>{
    if(editingRef.current)return;
    s.inspectTask(t.id);clearTimeout(clickTimer.current);
    // A double-click edits without opening a Thread or navigating away.
    clickTimer.current=setTimeout(()=>s.openTask(t.id),300);
  };
  return <section className="page task-page" aria-label="全局任务树" ref={pageRef} onScroll={e=>{const scroll=e.currentTarget.scrollTop;s.setTaskQuery(q=>q.scroll===scroll?q:{...q,scroll})}}>
    <div className="page-header"><div><h2>全部任务</h2><p>单击名称打开会话，双击编辑；单击行空白联动详情。右键设置任务或状态。</p></div></div>
    <TaskFilters/>
    <div className="table-head"><span>任务</span><span>关联会话</span></div>
    {rows.slice(currentPage*200,(currentPage+1)*200).map(({task:t,depth,contextOnly})=><div key={t.id} data-task-row={t.id} className={`task-row ${depth?'child':''} ${contextOnly?'context-only':''} ${t.id===s.task?.id?'highlight':''} ${!t.parent_id&&t.pinned?'root-pinned':''}`} onClick={()=>s.inspectTask(t.id)} onContextMenu={e=>openMenu(e,t)} onKeyDown={e=>{if(e.key==='F10'&&e.shiftKey){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();setMenu({task:t,x:r.left+30,y:r.top+20})}}}>
      <div className="task-title" style={{paddingLeft:depth*17}}>
        <button className="collapse" aria-label={`${collapsed.has(t.id)?'展开':'折叠'} ${t.title}`} disabled={!s.data.tasks.some(x=>x.parent_id===t.id)} onClick={e=>{e.stopPropagation();setCollapsed(current=>{const next=new Set(current);if(next.has(t.id))next.delete(t.id);else next.add(t.id);return next})}}>{s.data.tasks.some(x=>x.parent_id===t.id)?collapsed.has(t.id)?<ChevronRight size={13}/>:<ChevronDown size={13}/>:<span className="tree-spacer"/>}</button>
        <button className="task-status-control" aria-label={`${t.title}：${taskLabel(t)}，点击完成，右键改状态`} title="点击完成 · 右键设置状态" onClick={e=>{e.stopPropagation();if(t.status!=='completed')s.changeTaskState(t,'completed')}} onContextMenu={e=>openMenu(e,t,true)}><StatusIcon status={t.status} blocked={Boolean(t.missing_dependencies.length)}/></button>
        <div className="task-name-stack">{editing?.id===t.id?<input ref={editInput} className="task-title-editor" aria-label={`编辑任务名称 ${t.id}`} value={editing.text} onChange={e=>setEditing({...editing,text:e.target.value})} onClick={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onKeyDown={e=>void editKey(e,t)} onBlur={()=>{if(!editLock.current)void persistTitle().catch(e=>s.notify(String(e)))}}/>:<HoverInfo data={s.data} task={t} onOpen={()=>s.inspectTask(t.id,'content')} onResults={()=>s.inspectTask(t.id,'content')}><button className="task-title-btn" onClick={e=>{e.stopPropagation();selectAndOpen(t)}} onDoubleClick={e=>{e.preventDefault();e.stopPropagation();edit(t)}} onKeyDown={e=>{if(e.key==='F2'){e.preventDefault();edit(t)}}}>{t.title}</button></HoverInfo>}
        {contextOnly&&<span className="ancestor-label">层级路径</span>}
        {t.scheduled_start_at&&s.data.work_tasks.some(w=>w.task_id===t.id&&w.wait_reason==='scheduled')&&<span className="scheduled-tag"><Clock size={12}/>等待开始 · {new Date(t.scheduled_start_at).toLocaleString('zh-CN')}</span>}
        {t.blocked_by.length>0&&<button className={`dependency-tag ${t.missing_dependencies.length?'waiting':'ready'}`} onClick={e=>{e.stopPropagation();s.openDialog({kind:'dependencies',task:t.id})}}><Link size={11}/>{t.missing_dependencies.length===1?`等待：${s.data.tasks.find(x=>x.id===t.missing_dependencies[0])?.title||'前置交付'}`:t.missing_dependencies.length?`等待 ${t.missing_dependencies.length} 项`:`${t.blocked_by.length} 项前置已就绪`}</button>}</div>
        {!t.parent_id&&t.pinned&&<Pin size={12} className="pin-mark"/>}
      </div>
      <div className="sessions-cell">{taskConversations(s.data,t.id).map(c=><button key={c.id} className="session-chip" title={c.title} onClick={e=>{e.stopPropagation();s.openConversation(c.id)}}><MessageSquare size={12}/><span className="truncate">{c.title}</span></button>)}{!taskConversations(s.data,t.id).length&&<span className="muted no-conversations">尚无会话</span>}<button className="iconbtn new-task-conversation" aria-label={`为 ${t.title} 新建会话`} title="新建同任务会话" disabled={s.busy||['completed','cancelled'].includes(t.status)} onClick={e=>{e.stopPropagation();void s.newConversation(t.id)}}><Plus size={16}/></button></div>
    </div>)}
    {!rows.length&&<div className="empty-search">{query?'没有匹配的任务':'创建一个任务开始工作'}</div>}
    <div className="tree-foot"><span>符合筛选 {matched.size} 项 · 当前展开 {rows.length} 项（含层级路径）</span><div className="flex gap"><button className="textbtn" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {lastPage+1}</span><button className="textbtn" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>下一页</button></div></div>
    {menu&&<TaskMenu menu={menu} close={()=>setMenu(undefined)}/>}
  </section>;
}
