import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, Folder, FilePlus, GitPullRequest, Globe, PanelRight, Plus, Terminal, X } from 'lucide-react';
import { useStudio } from './context';
import { BrowserPane, type BrowserController } from './BrowserPane';
import { WorkspaceFiles } from './WorkspaceFiles';
import { WorkspaceTerminal, type TerminalHandle } from './WorkspaceTerminal';
import { executionDiff } from '../workbench/events';
import { closeTab, maxDockOwners, maxToolTabs, openTab, readDockLayout, saveDockLayout, syncPages, type DockKind, type DockTab } from './dockTabs';
import { DockLauncher } from './DockLauncher';
import './workspace-tools.css';
const icons={files:Folder,terminal:Terminal,diff:GitPullRequest,browser:Globe,launcher:FilePlus};
const labels:Record<DockKind,string>={files:'文件',terminal:'新建终端',diff:'变更',browser:'侧边浏览器',launcher:'新标签页'};
export function RightDock({available:enabled=true,headerHost}:{persistent?:boolean;available?:boolean;headerHost?:HTMLElement|null}){
 const s=useStudio(),owner=s.conversation?.id||`draft:${s.task?.id||'new'}`;
 const available=enabled&&!s.conversation?.closed;
 const [layout] = useState(readDockLayout);
 const [state,setState]=useState(layout.state),[collapsed,setCollapsed]=useState(layout.collapsed),[width,setWidth]=useState<number>();
 const [controller,setController]=useState<{owner:string;value:BrowserController}>();
 const metadata=useRef(new Map<string,{taskId:string;workspace:string}>()),terminals=useRef(new Map<string,TerminalHandle>()),handled=useRef(0);
 const shortcutHandled=useRef(0),storageError=useRef(false),focusLauncher=useRef<string>();
 const dock=useRef<HTMLElement>(null),browserRequest=useRef<{owner:string;action:'open'|'new';url?:string}>();
 const [fileTarget,setFileTarget]=useState<{owner:string;target:string;sequence:number}>();
 const ownerTabs=state.tabs.filter(tab=>tab.owner===owner);
 const active=state.active[owner],current=ownerTabs.find(t=>t.id===active),visible=available&&!collapsed[owner]&&ownerTabs.length>0;
 const project=s.data.projects.find(p=>p.id===s.task?.effective_project_id);
 const workspace=s.conversation?.config.workspace||project?.path||'',taskId=s.conversation?`conversation:${s.conversation.id}`:s.task?.id||'';
 useEffect(()=>{
  if(visible&&current?.kind==='terminal'&&!metadata.current.has(current.id)){
   metadata.current.set(current.id,{taskId,workspace});
   setState(value=>({...value}));
  }
 },[visible,current?.id,current?.kind,taskId,workspace]);
 const notifyRef=useRef(s.notify);
 notifyRef.current=s.notify;
 useEffect(()=>{
  try { saveDockLayout(state,collapsed); storageError.current=false; }
  catch { if(!storageError.current){storageError.current=true;notifyRef.current('无法保存右侧标签，请检查本机存储。');} }
 },[state,collapsed]);

 const expand = () => {
  setCollapsed(value=>value[owner]?{...value,[owner]:false}:value);
  setWidth(value=>value??Math.min(innerWidth*.5,900));
 };
 const open=useCallback((kind:Exclude<DockKind,'launcher'>,newBrowser=false,target?:string,launcher?:string)=>{
  if(!available)return;
  if(kind==='browser'&&!s.conversation&&(launcher||s.api.native)){s.notify('先打开已有会话，再使用右侧浏览器。');return;}
  const existing=[...ownerTabs].reverse().find(t=>t.kind===kind);
  const needsTab=kind==='terminal'||!existing;
  if(needsTab&&!launcher&&!canAddTool(state.tabs,owner)){s.notify('右侧标签已达上限，请关闭不用的标签。');return;}
  expand();s.setPanel(kind);
  if(kind==='browser')browserRequest.current={owner,action:newBrowser?'new':'open',url:target};
  if(kind==='files'&&!target)setFileTarget(undefined);
  // 标签 ID 跨重启稳定，只有本轮实际创建的终端才在后台保留组件。
  const id=kind==='terminal'?`${owner}:${nextInstance('terminal',ownerTabs)}`:existing?.id||`${kind}:${owner}`;
  if(!metadata.current.has(id))metadata.current.set(id,{taskId,workspace});
  setState(value=>openTab(launcher?closeTab(value,launcher):value,owner,kind,id));
 },[owner,ownerTabs,state.tabs,taskId,workspace,s.setPanel,s.notify,s.conversation?.id,s.api.native,available]);
 const openLauncher = () => {
  if(!available)return;
  if(!canAddTool(state.tabs,owner)){s.notify('右侧标签已达上限，请关闭不用的标签。');return;}
  const id=`${owner}:${nextInstance('launcher',ownerTabs)}`;
  focusLauncher.current=id;
  expand();
  setState(value=>openTab(value,owner,'launcher',id));
 };
 useEffect(()=>{
  if(!visible||current?.kind!=='launcher'||current.id!==focusLauncher.current)return;
  focusLauncher.current=undefined;
  dock.current?.querySelector<HTMLInputElement>('.dock-launcher input')?.focus();
 },[visible,current?.kind,current?.id]);
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
  if(request.url)void browser.operation('new_page',{url:request.url}).then(value=>{if(value)void browser.start()});
  else if(!browser.started||!browser.state?.pages.length)void browser.start();else if(request.action==='new')void browser.operation('new_page');
 },[visible,current?.id,current?.kind,state,controller,owner]);
 const select=(tab:DockTab)=>{
  browserRequest.current=undefined;
  if(tab.kind==='terminal'&&!metadata.current.has(tab.id))metadata.current.set(tab.id,{taskId,workspace});
  setState(value=>({...value,active:{...value.active,[owner]:tab.id}}));
  if(tab.kind!=='launcher')s.setPanel(tab.kind);
 };
 const close=async(tab:DockTab)=>{
  try{
   if(tab.kind==='browser'&&tab.pageId&&controller?.owner===owner)await controller.value.operation('close_page',{target_id:tab.pageId});
   if(tab.kind==='terminal')await terminals.current.get(tab.id)?.close();
   metadata.current.delete(tab.id);setState(value=>closeTab(value,tab.id));
   // 原生网页销毁后焦点回到应用，下一次关闭仍取当前面板。
   if(visible&&tab.id===active)requestAnimationFrame(()=>{
    const next=dock.current?.querySelector<HTMLElement>('.dock-content:not([hidden]) input, .dock-content:not([hidden]) button');
    (next??document.querySelector<HTMLElement>('.composer textarea'))?.focus();
   });
  }catch(cause){s.notify(`关闭失败：${String(cause)}`)}
 };
 useEffect(()=>{
  const request=s.dockShortcut;
  if(!request||request.sequence===shortcutHandled.current)return;
  shortcutHandled.current=request.sequence;
  if(!available)return;
  if(request.action==='newTab')openLauncher();
  else if(visible&&current)void close(current);
 },[s.dockShortcut,available,current,visible]);
 const resize=(next:number)=>{
  // 按正文剩余空间约束，不能把中间会话或固定任务属性挤出窗口。
  const maximum=Math.max(220,(dock.current?.parentElement?.clientWidth||innerWidth)-320);
  setWidth(Math.max(Math.min(270,maximum),Math.min(maximum,next)));
 };
 const diffId = visible && current?.kind === 'diff' && s.detail?.history_paged ? s.conversation?.id : undefined;
 const [diff,setDiff] = useState<{id:string;text:string}>();
 useEffect(() => {
  const completed = new Set((s.data.conversations ?? []).filter(c => c.closed).map(c => c.id));
  if (!completed.size) return;
  // 普通切换保留工具。完成后清掉后台组件和持久化标签，恢复会话时从空右栏开始。
  const removed = state.tabs.filter(tab => completed.has(tab.owner));
  if (removed.length) {
   for (const tab of removed) metadata.current.delete(tab.id);
   setState(value => ({
    tabs: value.tabs.filter(tab => !completed.has(tab.owner)),
    active: Object.fromEntries(Object.entries(value.active).filter(([id]) => !completed.has(id))),
   }));
   setCollapsed(value => Object.fromEntries(Object.entries(value).filter(([id]) => !completed.has(id))));
  }
  if (browserRequest.current && completed.has(browserRequest.current.owner)) browserRequest.current = undefined;
  setController(value => value && completed.has(value.owner) ? undefined : value);
  setFileTarget(value => value && completed.has(value.owner) ? undefined : value);
  setDiff(value => value && completed.has(value.id) ? undefined : value);
 }, [s.data.conversations, state.tabs]);
 useEffect(() => {
  if (!diffId) return;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  async function refreshDiff() {
   try {
    const text = await s.api.call<string>('history_diff', {conversation_id: diffId});
    if (!disposed) setDiff({id:diffId!,text});
   } catch (error) {
    if (!disposed) setDiff({id:diffId!,text:String(error)});
   } finally {
    if (!disposed) timer = setTimeout(refreshDiff, 2500);
   }
  }
  void refreshDiff();
  return () => {disposed = true; clearTimeout(timer);};
 }, [diffId,s.api]);
 const regionStyle=width?{width}:undefined;
 const header=<div className={`dock-tabbar workspace-tool-region ${visible?'':'tools-collapsed'}`} role="toolbar" aria-label="右侧工具操作" hidden={!available} style={visible?regionStyle:undefined}>
  <div className="dock-tabs" role="tablist" aria-label="右侧工具标签" hidden={!visible}>{ownerTabs.map(tab=>{const Icon=icons[tab.kind];return <div key={tab.id} className={`dock-tab ${active===tab.id?'active':''}`}><button role="tab" aria-selected={active===tab.id} title={tab.title} onClick={()=>select(tab)}><Icon size={14}/><span>{tab.title}{tab.kind==='terminal'?` ${tab.id.split('-').slice(-1)[0]}`:''}</span></button><button className="tab-close" aria-label={`关闭${tab.title}标签`} onClick={()=>void close(tab)}><X size={12}/></button></div>})}</div>
  <div className="dock-tool-shortcuts">{(['files','terminal','browser','diff'] as const).map(kind=>{const Icon=icons[kind];return <button className={`iconbtn ${visible&&current?.kind===kind?'selected':''}`} aria-label={labels[kind]} title={labels[kind]} key={kind} onClick={()=>open(kind)}><Icon size={15}/></button>})}</div>
  <div className="dock-tab-actions"><button className="iconbtn" aria-label="新建右侧标签" onClick={openLauncher}><Plus size={16}/></button><button className="iconbtn" aria-label={visible?'收起右侧工作区':ownerTabs.length?'展开右侧工作区':'打开右侧工具'} aria-expanded={visible} onClick={()=>ownerTabs.length?setCollapsed(value=>({...value,[owner]:!value[owner]})):openLauncher()}><PanelRight size={16}/></button></div>
 </div>;
 return <>{headerHost?createPortal(header,headerHost):header}<aside className="right-dock workspace-tool-region" ref={dock} aria-label="右侧工作区" hidden={!visible} style={regionStyle}>
  <div className="dock-resize" role="separator" aria-label="调整右侧宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize((dock.current?.clientWidth||400)+(e.key==='ArrowLeft'?20:-20))}}} onPointerDown={e=>{e.preventDefault();const initial=dock.current?.clientWidth||400,start=e.clientX,handle=e.currentTarget;handle.setPointerCapture(e.pointerId);const move=(event:PointerEvent)=>resize(initial+start-event.clientX);const finish=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish)};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish)}}/>
  {!current&&<div className="workspace-tool-empty"><PanelRight size={28}/><p>选择工具，在右侧工作区打开。</p></div>}
  {!s.conversation?.closed&&<div hidden={current?.kind!=='browser'} className="dock-content"><BrowserPane active={visible&&current?.kind==='browser'} externalTabs restore={available} occluded={s.overlayOpen} selectedPage={current?.pageId} onController={onBrowser}/></div>}
  {state.tabs.filter(t=>t.kind==='files'||t.kind==='terminal').map(tab=>{const data=metadata.current.get(tab.id)??(tab.owner===owner&&tab.kind==='files'?{taskId,workspace}:undefined);
   if(!data&&tab.owner!==owner)return null;
   return <div key={tab.id} hidden={tab.owner!==owner||active!==tab.id} className="dock-content">
    {tab.kind==='files'&&data
     ? <WorkspaceFiles taskId={data.taskId} workspace={data.workspace} enabled={s.api.native}
        openRequest={fileTarget?.owner===tab.owner?fileTarget:undefined}/>
     : data?.workspace
      ? <WorkspaceTerminal ref={handle=>{if(handle)terminals.current.set(tab.id,handle);else terminals.current.delete(tab.id)}}
         taskId={data.taskId} workspace={data.workspace} active={visible&&active===tab.id&&tab.owner===owner} enabled={s.api.native}/>
      : <div className="workspace-tool-empty"><File size={28}/><p>{!data?'选中标签后启动新终端。':'先选择有效的项目目录。'}</p></div>}
   </div>})}
  {current?.kind==='launcher'&&<div className="dock-content"><DockLauncher key={current.id} sites={s.recommendations??[]} open={(kind,url)=>open(kind,true,url,current.id)}/></div>}
  <div className="dock-content" hidden={current?.kind!=='diff'}><div className="workspace-tool-toolbar"><GitPullRequest size={15}/><span>当前会话变更</span></div><pre className="workspace-diff">{(diff && diff.id===diffId ? diff.text : executionDiff(s.detail?.events||[]))||'本会话还没有返回 Diff。'}</pre></div>
 </aside></>;
}

function nextInstance(kind: 'terminal' | 'launcher', tabs: DockTab[]) {
 const used=new Set(tabs.filter(tab=>tab.kind===kind).map(tab=>Number(tab.id.split('-').pop())));
 let number=1;
 while(used.has(number))number++;
 return `${kind}-${number}`;
}

function canAddTool(tabs: DockTab[], owner: string) {
 const owners=new Set(tabs.map(tab=>tab.owner));
 return (owners.has(owner)||owners.size<maxDockOwners)
  && tabs.filter(tab=>tab.owner===owner&&tab.kind!=='browser').length<maxToolTabs;
}
