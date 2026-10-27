import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, ListTree, Folder, Settings2, Bell, Plus, PanelLeft, AlertCircle, X } from "lucide-react";
import { StudioContext, type DialogState, type Draft, type Panel, type View } from "./context";
import { nativeApi, type StudioApi } from "./api";
import { createDemoApi } from "./demo";
import { emptyWorkspace, preferredConversation, isBusy, needsUser, type Workspace, type Conversation, type ConversationDetail, type StudioTask } from "./model";
import { ConversationHeader, ChatSurface } from "./ChatSurface";
import { Sidebar } from "./Sidebar";
import { TaskTree } from "./TaskTree";
import { RightDock } from "./RightDock";
import { AttentionPage, ProjectsPage, SettingsPage } from "./Pages";
import { Dialogs } from "./Dialogs";
import "./studio.css";

const blankDraft = (): Draft => ({ text: '', attachments: [], importContext: false });
const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let autoConnection: Promise<unknown> | undefined;
export default function ChatApp({ api: supplied }: { api?: StudioApi }) {
  const api = useMemo(() => supplied ?? (native() ? nativeApi : createDemoApi()), [supplied]);
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [view, setViewState] = useState<View>('chat');
  const [taskScreen, setTaskScreen] = useState<'tree'|'conversation'>('tree');
  const [selection, setSelection] = useState<{ task?: string; conversation?: string }>({});
  const [panel, setPanelState] = useState<Panel>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [projectId, setProjectId] = useState('');
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busyCount, setBusyCount] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [showSidebar, setShowSidebar] = useState(true);
  const latest = useRef(data); latest.current = data;
  const viewRef=useRef(view); viewRef.current=view;
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const snapshotSequence = useRef(0), detailSequence = useRef(0), mounted = useRef(true), locks = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const refresh = useCallback(async () => {
    const n = ++snapshotSequence.current;
    const value = await api.call<Workspace>('snapshot');
    if (mounted.current && n === snapshotSequence.current) { setData(value); setError(''); setLoading(false); }
  }, [api]);
  const refreshDetail = useCallback(async () => {
    const cid = currentSelection.current.conversation;
    const n = ++detailSequence.current;
    if (!cid) { setDetail(null); return; }
    const value = await api.call<ConversationDetail>('detail', { conversation_id: cid });
    if (mounted.current && n === detailSequence.current && cid === currentSelection.current.conversation) setDetail(value);
  }, [api]);
  useEffect(() => {
    mounted.current = true; let stopped = false;
    const poll = async () => { try { await refresh(); } catch (e) { if (!stopped) { setError(String(e)); setLoading(false); } } };
    void poll(); const id = setInterval(() => void poll(), 2500);
    return () => { stopped = true; mounted.current = false; clearInterval(id); clearTimeout(timer.current); };
  }, [refresh]);
  useEffect(() => {
    // Only the native host reads its own authentication cache. Never copy tokens
    // into this frontend or import a Desktop-owned running Thread.
    if (!api.native || supplied) return;
    autoConnection ??= invoke('workbench_connect', { executable: null });
    void autoConnection.then(() => refresh()).catch(() => refresh().catch(()=>{}));
  }, [api, supplied, refresh]);
  useEffect(() => {
    setDetail(null); void refreshDetail().catch(e => setError(String(e)));
    const id=setInterval(()=>void refreshDetail().catch(e=>setError(String(e))),1200);
    return ()=>{clearInterval(id);detailSequence.current++;};
  }, [selection.conversation,refreshDetail]);
  const notify = useCallback((text:string)=>{setNotice(text);clearTimeout(timer.current);timer.current=setTimeout(()=>setNotice(''),5500);},[]);
  const command = useCallback(async <T,>(method:string,params:Record<string,unknown>={},success?:string):Promise<T>=>{
    const key=`${method}:${params.conversation_id||params.task_id||params.result_id||''}`;
    if(locks.current.has(key))throw new Error('该操作正在处理中');
    locks.current.add(key);setBusyCount(x=>x+1);
    try{const result=await api.call<T>(method,params);await refresh();await refreshDetail();if(success)notify(success);return result;}
    catch(e){notify(String(e));throw e;}
    finally{locks.current.delete(key);if(mounted.current)setBusyCount(x=>Math.max(0,x-1));}
  },[api,refresh,refreshDetail,notify]);
  const setPanel=useCallback((next:Panel)=>setPanelState(next==='context'||next==='results'?'content':next),[]);
  const openConversation=useCallback((id:string)=>{
    const c=latest.current.conversations.find(x=>x.id===id);
    if(!c){notify('来源会话暂不可见，请恢复对应任务');return;}
    setSelection({task:c.task_id,conversation:id});
    if(viewRef.current==='tasks')setTaskScreen('conversation');else setViewState('chat');
    void api.call('visit',{conversation_id:id}).catch(e=>notify(String(e)));
  },[api,notify]);
  const openTask=useCallback((id:string)=>{
    const t=latest.current.tasks.find(x=>x.id===id);if(!t)return;
    const c=preferredConversation(latest.current,t);
    if(c)openConversation(c.id);else{
      setSelection({task:id});if(viewRef.current==='tasks')setTaskScreen('conversation');else setViewState('chat');
    }
  },[openConversation]);
  const inspectTask=useCallback((id:string,nextPanel?:Panel)=>{
    const t=latest.current.tasks.find(x=>x.id===id);if(!t)return;
    setSelection({task:id,conversation:preferredConversation(latest.current,t)?.id});
    // Selecting another task must not reset the inspector tab chosen by the user.
    if(nextPanel)setPanel(nextPanel);
  },[setPanel]);
  const locateTask=useCallback((id:string)=>{
    const t=latest.current.tasks.find(x=>x.id===id);if(!t)return;
    setSelection({task:id,conversation:preferredConversation(latest.current,t)?.id});
    setViewState('tasks');setTaskScreen('tree');setProjectFilter('');
  },[]);
  const newConversation=useCallback(async(taskId:string)=>{
    try{const c=await command<Conversation>('create_conversation',{task_id:taskId});setSelection({task:taskId,conversation:c.id});if(viewRef.current==='tasks')setTaskScreen('conversation');else setViewState('chat');}catch{/* command displays error */}
  },[command]);
  const changeTaskState=useCallback((t:StudioTask,state:StudioTask['status'])=>{
    if(t.status===state)return;
    if(latest.current.conversations.some(c=>c.task_id===t.id&&isBusy(c))||latest.current.work_tasks.some(w=>w.task_id===t.id&&w.current_run_id)){
      setDialog({kind:'taskState',task:t.id,state});return;
    }
    void command('task_state',{task_id:t.id,state,confirm_stop:false},'任务状态已更新').catch(()=>{});
  },[command]);
  const setView=useCallback((next:View)=>{setViewState(next);if(next==='tasks'){setTaskScreen('tree');setProjectFilter('');}},[]);
  // The tree has a stable selection and persistent inspector even before opening a chat.
  useEffect(()=>{if(view==='tasks'&&!latest.current.tasks.some(t=>t.id===currentSelection.current.task)&&data.tasks.length)inspectTask(data.tasks[0].id);},[view,data.tasks,inspectTask]);
  const conversation=data.conversations.find(c=>c.id===selection.conversation);
  const task=data.tasks.find(t=>t.id===selection.task||!selection.task&&t.id===conversation?.task_id);
  const draftKey=conversation?.id||(task?`task:${task.id}`:'new-chat');
  const draft=drafts[draftKey]||blankDraft();
  const setDraft=(next:Draft)=>setDrafts(current=>({...current,[draftKey]:next}));
  const changeProject=(id:string)=>{
    if(conversation)void command('update_conversation',{conversation_id:conversation.id,revision:conversation.revision,patch:{project_id:id}}).catch(()=>{});
    else if(task)setDraft({...draft,projectId:id});else setProjectId(id);
  };
  const send=async()=>{
    const sourceKey=draftKey,captured=draft;let tid=task?.id,cid=conversation?.id;
    const chosen=conversation?.project_id||captured.projectId||task?.effective_project_id||(!task?projectId:'');
    if(!chosen&&!conversation?.config.workspace){notify('先选择一个本地项目；草稿会保留');setDialog(task?{kind:'projectTask',task:task.id}:{kind:'project'});return;}
    try{
      if(!tid){const created=await command<{task_id:string}>('create_task',{title:captured.text.trim().split('\n')[0].slice(0,100)||captured.attachments[0]?.name||'新任务',project_id:chosen});tid=created.task_id;setSelection({task:tid});}
      if(!cid){const c=await command<Conversation>('create_conversation',{task_id:tid,project_id:chosen});cid=c.id;setSelection({task:tid,conversation:cid});}
      const content=[captured.text,...captured.attachments.filter(a=>a.text!=null).map(a=>`\n以下是用户附加文件「${a.name}」的内容（引用材料）：\n${a.text}`)].filter(Boolean).join('\n');
      await command('send',{conversation_id:cid,text:content,attachments:captured.attachments.flatMap(a=>a.input?[a.input]:[]),import_context:captured.importContext,expected_run_id:conversation?.current_run_id??null});
      setDrafts(current=>current[sourceKey]===captured||!current[sourceKey]?{...current,[sourceKey]:blankDraft(),[cid!]:blankDraft()}:current);
    }catch{if(cid&&cid!==sourceKey)setDrafts(current=>({...current,[cid!]:captured}));}
  };
  const newChat=()=>{setSelection({});if(view==='tasks')setTaskScreen('conversation');else setViewState('chat');};
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if(!(e.metaKey||e.ctrlKey))return;if(e.key==='1'){e.preventDefault();setView('chat');}else if(e.key==='2'){e.preventDefault();setView('tasks');}};
    document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
  },[setView]);
  const context={api,data,detail,task,conversation,view,panel,setPanel,openDialog:setDialog,setView,openTask,openConversation,locateTask,inspectTask,changeTaskState,newConversation,refresh,command,notify,busy:busyCount>0};
  const conversationVisible=view==='chat'||view==='tasks'&&taskScreen==='conversation';
  const attentionCount=data.conversations.filter(c=>needsUser(c,data)&&!c.closed).length;
  return <StudioContext.Provider value={context}><div className="studio studio-app">
    <div className="titlebar" data-tauri-drag-region><button className="iconbtn" aria-label="切换侧栏" onClick={()=>setShowSidebar(x=>!x)}><PanelLeft size={14}/></button><span className="title-name" data-tauri-drag-region>AgentKanban</span></div>
    <div className="frame"><nav className="rail" aria-label="主导航">
      {([{id:'chat',icon:MessageSquare,label:'会话'},{id:'tasks',icon:ListTree,label:'任务'},{id:'projects',icon:Folder,label:'项目'},{id:'attention',icon:Bell,label:'需要你'}] as const).map(item=><button key={item.id} className={`rbtn ${view===item.id?'active':''}`} title={item.label} aria-label={item.label} aria-current={view===item.id?'page':undefined} onClick={()=>setView(item.id)}><item.icon size={19}/>{item.id==='attention'&&attentionCount>0&&<span className="tiny-dot"/>}</button>)}
      <div className="spacer"/><button className={`rbtn ${view==='settings'?'active':''}`} title="设置" aria-label="设置" aria-current={view==='settings'?'page':undefined} onClick={()=>setView('settings')}><Settings2 size={19}/></button><div className="avatar" title="个人工作区">我</div>
    </nav>
    {showSidebar&&<Sidebar loading={loading} onNewChat={newChat} onAllTasks={()=>{setTaskScreen('tree');setProjectFilter('');}}/>}
    <main className="main">{error&&<div className="workspace-error" role="alert"><AlertCircle size={15}/><span>{error}</span><button className="textbtn" onClick={()=>void refresh().catch(e=>setError(String(e)))}>重试</button></div>}
      {conversationVisible?<><ConversationHeader/><div className="content-split"><ChatSurface draftKey={draftKey} draft={draft} setDraft={setDraft} onSend={send} projectId={draft.projectId||task?.effective_project_id||projectId} setProject={changeProject}/><RightDock persistent={view==='tasks'}/></div></>:view==='tasks'?<><header className="main-head"><h1>任务</h1><span className="grow"/><button className="textbtn" onClick={()=>setDialog({kind:'deleted'})}>已删除</button><button className="textbtn primary" onClick={()=>setDialog({kind:'createTask'})}><Plus size={14}/>新建任务</button></header><div className="content-split"><TaskTree projectFilter={projectFilter}/><RightDock persistent/></div></>:view==='projects'?<ProjectsPage onSelect={id=>{setProjectFilter(id);setTaskScreen('tree');setViewState('tasks');}}/>:view==='attention'?<AttentionPage/>:<SettingsPage/>}
    </main></div>
    {notice&&<div className="studio-toast show" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={13}/></button></div>}
    {dialog&&<Dialogs key={JSON.stringify(dialog)} dialog={dialog} onClose={()=>setDialog(null)} onImport={key=>setDrafts(current=>({...current,[key]:{...(current[key]||blankDraft()),importContext:true}}))} onNewProject={id=>{setProjectId(id);if(task&&!conversation)setDraft({...draft,projectId:id});}}/>}
  </div></StudioContext.Provider>;
}
