import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, Folder, GitPullRequest, Globe, PanelRight, Plus, Terminal, X } from 'lucide-react';
import { useStudio } from './context';
import { BrowserPane, type BrowserController } from './BrowserPane';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspaceTerminal, type TerminalHandle } from './WorkspaceTerminal';
import { executionDiff } from '../workbench/events';
import { closeTab, emptyDock, openTab, syncPages, type DockKind, type DockTab } from './dockTabs';
import './workspace-tools.css';
const icons={files:Folder,terminal:Terminal,diff:GitPullRequest,browser:Globe};
const labels:Record<DockKind,string>={files:'文件',terminal:'新建终端',diff:'变更',browser:'侧边浏览器'};
export function RightDock({available=true,headerHost}:{persistent?:boolean;available?:boolean;headerHost?:HTMLElement|null}){
 const s=useStudio(),owner=s.conversation?.id||s.task?.id||'new';
 const [state,setState]=useState(emptyDock),[menu,setMenu]=useState(false),[collapsed,setCollapsed]=useState(true),[width,setWidth]=useState<number>();
 const [controller,setController]=useState<{owner:string;value:BrowserController}>();
 const metadata=useRef(new Map<string,{taskId:string;workspace:string}>()),terminals=useRef(new Map<string,TerminalHandle>()),serial=useRef(0),handled=useRef(0);
 const menuAnchor=useRef<HTMLDivElement>(null),dock=useRef<HTMLElement>(null),browserRequest=useRef<{owner:string;action:'open'|'new';url?:string}>();
 const [fileTarget,setFileTarget]=useState<{owner:string;target:string;sequence:number}>();
 useEffect(()=>{if(!available)setMenu(false)},[available]);
 useEffect(()=>{
  if(!menu)return;
  const outside=(event:PointerEvent)=>{if(!menuAnchor.current?.contains(event.target as Node))setMenu(false)};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setMenu(false)};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)};
 },[menu]);
 const ownerTabs=state.tabs.filter(tab=>tab.owner===owner);
 const active=state.active[owner],current=ownerTabs.find(t=>t.id===active),visible=available&&!collapsed&&ownerTabs.length>0;
 const project=s.data.projects.find(p=>p.id===s.task?.effective_project_id);
 const workspace=s.conversation?.config.workspace||project?.path||'',taskId=s.conversation?`conversation:${s.conversation.id}`:s.task?.id||'';
 const open=useCallback((kind:DockKind,newBrowser=false,target?:string)=>{
  if(!available)return;
  setMenu(false);setCollapsed(false);setWidth(value=>value??Math.min(innerWidth*.5,900));s.setPanel(kind);
  if(kind==='browser')browserRequest.current={owner,action:newBrowser?'new':'open',url:target};
  if(kind==='files'&&!target)setFileTarget(undefined);
  // 分配身份不能放入可重复执行的 React 更新器，避免创建多余终端。
  const id=kind==='terminal'?`terminal-${++serial.current}`:`${kind}:${owner}`;
  if(!metadata.current.has(id))metadata.current.set(id,{taskId,workspace});
  setState(value=>{
   const existing=[...value.tabs].reverse().find(t=>t.owner===owner&&t.kind===kind);
   if(kind==='terminal')return openTab(value,owner,kind,id);
   if(existing)return {...value,active:{...value.active,[owner]:existing.id}};
   return openTab(value,owner,kind,id);
  });
 },[owner,taskId,workspace,s.setPanel,available]);
 useEffect(()=>{
  const request=s.toolRequest;if(!request||request.sequence===handled.current)return;
  handled.current=request.sequence;if(!available)return;open(request.kind,false,request.target);
  if(request.kind==='files'&&request.target)setFileTarget({owner,target:request.target,sequence:request.sequence});
 },[s.toolRequest,open,available]);
 const onBrowser=useCallback((value:BrowserController)=>{
  setController({owner,value});
  if(value.state)setState(old=>{const next=syncPages(old,owner,value.state!.pages,value.state!.target_id);return JSON.stringify(old)===JSON.stringify(next)?old:next});
 },[owner]);
 useEffect(()=>{
  const browser=controller?.owner===owner?controller.value:undefined,request=browserRequest.current;
  if(request&&request.owner!==owner){browserRequest.current=undefined;return}
  if(!visible||current?.kind!=='browser'||!browser||!request)return;
  browserRequest.current=undefined;
  if(request.url)void browser.operation('new_page',{url:request.url}).then(()=>browser.start());
  else if(!browser.started||!browser.state?.pages.length)void browser.start();else if(request.action==='new')void browser.operation('new_page');
 },[visible,current?.id,current?.kind,state,controller,owner]);
 const select=(tab:DockTab)=>{browserRequest.current=undefined;setState(value=>({...value,active:{...value.active,[owner]:tab.id}}));s.setPanel(tab.kind)};
 const close=async(tab:DockTab)=>{
  try{
   if(tab.kind==='browser'&&tab.pageId&&controller?.owner===owner)await controller.value.operation('close_page',{target_id:tab.pageId});
   if(tab.kind==='terminal')await terminals.current.get(tab.id)?.close();
   metadata.current.delete(tab.id);setState(value=>closeTab(value,tab.id));
  }catch(cause){s.notify(`关闭失败：${String(cause)}`)}
 };
 const resize=(next:number)=>{
  // 按正文剩余空间约束，不能把中间会话或固定任务属性挤出窗口。
  const maximum=Math.max(220,(dock.current?.parentElement?.clientWidth||innerWidth)-320);
  setWidth(Math.max(Math.min(270,maximum),Math.min(maximum,next)));
 };
 const regionStyle=width?{width}:undefined;
 const header=<div className={`dock-tabbar workspace-tool-region ${visible?'':'tools-collapsed'}`} role="toolbar" aria-label="右侧工具操作" hidden={!available} style={visible?regionStyle:undefined}>
  <div className="dock-tabs" role="tablist" aria-label="右侧工具标签" hidden={!visible}>{ownerTabs.map(tab=>{const Icon=icons[tab.kind];return <div key={tab.id} className={`dock-tab ${active===tab.id?'active':''}`}><button role="tab" aria-selected={active===tab.id} title={tab.title} onClick={()=>select(tab)}><Icon size={14}/><span>{tab.title}{tab.kind==='terminal'?` ${tab.id.split('-').slice(-1)[0]}`:''}</span></button><button className="tab-close" aria-label={`关闭${tab.title}标签`} onClick={()=>void close(tab)}><X size={12}/></button></div>})}</div>
  <div className="dock-tool-shortcuts">{(['files','terminal','browser','diff'] as DockKind[]).map(kind=>{const Icon=icons[kind];return <button className={`iconbtn ${visible&&current?.kind===kind?'selected':''}`} aria-label={labels[kind]} title={labels[kind]} key={kind} onClick={()=>open(kind)}><Icon size={15}/></button>})}</div>
  <div className="dock-tab-actions"><div className="menu-anchor" ref={menuAnchor}><button className="iconbtn" aria-label="新建右侧标签" aria-expanded={menu} onClick={e=>{e.stopPropagation();setMenu(value=>!value)}}><Plus size={16}/></button>{menu&&<div className="inline-menu align-right" role="menu" aria-label="新建工具标签">{(['browser','terminal','files','diff'] as DockKind[]).map(kind=>{const Icon=icons[kind];return <button className="popitem" role="menuitem" key={kind} onClick={()=>open(kind,kind==='browser')}><Icon size={15}/>{{browser:'浏览器',terminal:'终端',files:'文件',diff:'变更'}[kind]}</button>})}</div>}</div><button className="iconbtn" aria-label={visible?'收起右侧工作区':ownerTabs.length?'展开右侧工作区':'打开右侧工具'} aria-expanded={visible} onClick={()=>ownerTabs.length?setCollapsed(value=>!value):setMenu(value=>!value)}><PanelRight size={16}/></button></div>
 </div>;
 return <>{headerHost?createPortal(header,headerHost):header}<aside className="right-dock workspace-tool-region" ref={dock} aria-label="右侧工作区" hidden={!visible} style={regionStyle}>
  <div className="dock-resize" role="separator" aria-label="调整右侧宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize((dock.current?.clientWidth||400)+(e.key==='ArrowLeft'?20:-20))}}} onPointerDown={e=>{e.preventDefault();const initial=dock.current?.clientWidth||400,start=e.clientX,handle=e.currentTarget;handle.setPointerCapture(e.pointerId);const move=(event:PointerEvent)=>resize(initial+start-event.clientX);const finish=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish)};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish)}}/>
  {!current&&<div className="workspace-tool-empty"><PanelRight size={28}/><p>选择工具，在右侧工作区打开。</p></div>}
  <div hidden={current?.kind!=='browser'} className="dock-content"><BrowserPane active={visible&&current?.kind==='browser'} externalTabs occluded={menu||s.overlayOpen} selectedPage={current?.pageId} onController={onBrowser}/></div>
  {state.tabs.filter(t=>t.kind==='files'||t.kind==='terminal').map(tab=>{const data=metadata.current.get(tab.id);return <div key={tab.id} hidden={tab.owner!==owner||active!==tab.id} className="dock-content">{data?.workspace?(tab.kind==='files'?<WorkspaceFiles taskId={data.taskId} workspace={data.workspace} enabled={s.api.native} openRequest={fileTarget?.owner===tab.owner?fileTarget:undefined}/>:<WorkspaceTerminal ref={handle=>{if(handle)terminals.current.set(tab.id,handle);else terminals.current.delete(tab.id)}} taskId={data.taskId} workspace={data.workspace} active={visible&&active===tab.id&&tab.owner===owner} enabled={s.api.native}/>):<div className="workspace-tool-empty"><File size={28}/><p>先选择有效的项目目录。</p></div>}</div>})}
  <div className="dock-content" hidden={current?.kind!=='diff'}><div className="workspace-tool-toolbar"><GitPullRequest size={15}/><span>当前会话变更</span></div><pre className="workspace-diff">{executionDiff(s.detail?.events||[])||'本会话还没有返回 Diff。'}</pre></div>
 </aside></>;
}
