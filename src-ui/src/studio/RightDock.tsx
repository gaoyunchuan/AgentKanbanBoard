import { useEffect, useRef, useState } from 'react';
import { ListTree, Terminal, GitPullRequest, Globe, X } from 'lucide-react';
import { useStudio } from './context';
import { Inspector } from './Inspector';
import { UtilityPanel } from './ChatSurface';
type Tool='detail'|'workspace'|'diff'|'browser';
const tools:{id:Tool;label:string;icon:typeof ListTree}[]=[{id:'detail',label:'任务详情',icon:ListTree},{id:'workspace',label:'文件与终端',icon:Terminal},{id:'diff',label:'变更',icon:GitPullRequest},{id:'browser',label:'浏览器',icon:Globe}];
export function RightDock({persistent=false}:{persistent?:boolean}){
 const s=useStudio();const requested:Tool=s.panel==='browser'||s.panel==='diff'||s.panel==='workspace'?s.panel:'detail';
 const [opened,setOpened]=useState<Tool[]>(['detail']);
 const [tab,setTab]=useState<'content'|'properties'>(()=>{try{return localStorage.getItem('akb.detailTab')==='properties'?'properties':'content'}catch{return 'content'}});
 const [width,setWidth]=useState<number>();const dock=useRef<HTMLElement>(null);
 useEffect(()=>{if(s.panel)setOpened(v=>v.includes(requested)?v:[...v,requested]);if(s.panel==='properties')setTab('properties');else if(s.panel==='content'||s.panel==='context'||s.panel==='results')setTab('content')},[s.panel]);
 const changeTab=(value:'content'|'properties')=>{setTab(value);try{localStorage.setItem('akb.detailTab',value)}catch{};s.setPanel(value)};
 const visible=persistent||s.panel!==null;
 const active=!s.panel&&persistent?'detail':requested;
 return <aside className="right-dock" ref={dock} aria-label="右侧工作区" hidden={!visible} style={width?{width,minWidth:Math.min(width,300)}:undefined}>
 <div className="dock-resize" role="separator" aria-label="调整右侧宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(Math.max(300,Math.min(innerWidth*.65,(dock.current?.clientWidth||400)+(e.key==='ArrowLeft'?20:-20))))}}} onPointerDown={e=>{e.preventDefault();const initial=dock.current?.clientWidth||400,start=e.clientX;const handle=e.currentTarget;handle.setPointerCapture(e.pointerId);const move=(event:PointerEvent)=>setWidth(Math.max(300,Math.min(innerWidth*.65,initial+start-event.clientX)));const finish=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish)};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish)}}/>
 <div className="dock-tabs" role="tablist" aria-label="右侧工具标签">{opened.map(id=>{const item=tools.find(t=>t.id===id)!;return <div key={id} className={`dock-tab ${active===id?'active':''}`}><button role="tab" aria-selected={active===id} onClick={()=>s.setPanel(id==='detail'?tab:id)}><item.icon size={14}/>{item.label}</button>{id!=='detail'&&<button className="tab-close" aria-label={`关闭${item.label}标签`} onClick={()=>{setOpened(v=>v.filter(x=>x!==id));if(active===id)s.setPanel(tab)}}><X size={12}/></button>}</div>})}{!persistent&&<button className="iconbtn dock-close" aria-label="收起右侧工作区" onClick={()=>s.setPanel(null)}><X size={15}/></button>}</div>
 <div hidden={active!=='detail'} className="dock-content"><Inspector tab={tab} onTab={changeTab}/></div>{opened.filter(id=>id!=='detail').map(id=><div hidden={active!==id} key={id} className="dock-content"><UtilityPanel kind={id as Exclude<Tool,'detail'>} active={visible&&active===id}/></div>)}
 </aside>;
}
