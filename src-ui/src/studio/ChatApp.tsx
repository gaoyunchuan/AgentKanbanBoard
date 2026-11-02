import {isFileLink} from "./Markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, ListTree, Folder, Settings2, Bell, AlertCircle, X } from "lucide-react";
import { StudioContext, type DialogState, type Draft, type ModelConfig, type Panel, type View } from "./context";
import { nativeApi, type StudioApi } from "./api";
import { createDemoApi } from "./demo";
import { emptyWorkspace, preferredConversation, isBusy, needsUser, type Workspace, type Conversation, type ConversationDetail, type StudioTask } from "./model";
import { ChatSurface } from "./ChatSurface";
import { Sidebar } from "./Sidebar";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { TaskTree } from "./TaskTree";
import { RightDock } from "./RightDock";
import { TaskDetails } from "./TaskDetails";
import "./workspace-layout.css";
import { AttentionPage, ProjectsPage, SettingsPage } from "./Pages";
import { Dialogs } from "./Dialogs";
import { readTaskQuery, writeTaskQuery, taskQueryForReveal } from "./taskFilters";
import "./studio.css";
import "./controls.css";

const blankDraft = (): Draft => ({ text: '', attachments: [], importContext: false });
const hasDraft=(value?:Draft)=>Boolean(value&&(value.text||value.attachments.length||value.importContext||value.projectId||value.modelConfig));
const native = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let autoConnection: Promise<unknown> | undefined;
export default function ChatApp({ api: supplied }: { api?: StudioApi }) {
  const api = useMemo(() => supplied ?? (native() ? nativeApi : createDemoApi()), [supplied]);
  const [data, setData] = useState<Workspace>(emptyWorkspace);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [view, setViewState] = useState<View>('tasks');
  const [taskScreen, setTaskScreen] = useState<'tree'|'conversation'>('tree');
  const [selection, setSelection] = useState<{ task?: string; conversation?: string }>({});
  const [panel, setPanelState] = useState<Panel>(null);
  const [toolRequest,setToolRequest]=useState<{kind:'files'|'terminal'|'diff'|'browser';sequence:number;target?:string}>();
  const [panelRevision,setPanelRevision]=useState(0);
  const [inspectorOpen,setInspectorOpen]=useState(false);
  const [inspectorTab,setInspectorTab]=useState<'content'|'properties'>(()=>{try{return localStorage.getItem('akb.detailTab')==='properties'?'properties':'content'}catch{return 'content'}});
  const [toolHost,setToolHost]=useState<HTMLDivElement|null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [taskQuery, setTaskQuery] = useState(readTaskQuery);
  const [taskReveal,setTaskReveal]=useState<string|null>(null);
  const completeTaskReveal=useCallback((id:string)=>setTaskReveal(current=>current===id?null:current),[]);
  useEffect(() => { writeTaskQuery(taskQuery); }, [taskQuery]);
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
    // 命令完成后的导航需要立即读取新任务，不能依赖 React 何时提交这次快照。
    if (mounted.current && n === snapshotSequence.current) { latest.current=value; setData(value); setError(''); setLoading(false); }
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
  const setPanel=useCallback((next:Panel)=>{
    const detail=next==='properties'||next==='content'||next==='context'||next==='results';
    if(detail){const tab=next==='properties'?'properties':'content';setInspectorTab(tab);setInspectorOpen(true);try{localStorage.setItem('akb.detailTab',tab)}catch{}}
    if(next===null)setInspectorOpen(false);
    setPanelState(next==='context'||next==='results'?'content':next);setPanelRevision(value=>value+1);
  },[]);
  const openTool=useCallback((kind:'files'|'terminal'|'diff'|'browser',target?:string)=>{if(!(view==='chat'||view==='tasks'&&taskScreen==='conversation')){notify('右侧工具仅在会话中使用，请先打开会话');return}setPanelState(kind);setToolRequest(value=>({kind,target,sequence:(value?.sequence||0)+1}))},[view,taskScreen,notify]);
  useEffect(()=>{const open=(event:Event)=>{const href=(event as CustomEvent<unknown>).detail;if(typeof href!=='string')return;if(isFileLink(href))openTool('files',href);else if(/^https?:\/\//.test(href))openTool('browser',href)};window.addEventListener('akb:open-link',open);return()=>window.removeEventListener('akb:open-link',open)},[openTool]);
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
    const revealed=taskQueryForReveal(latest.current.tasks,taskQuery,id,Date.now());
    setTaskQuery(revealed.query);setTaskReveal(id);
    if(revealed.filtersReset)notify('已切回全部任务筛选，以显示所定位的任务');
    setSelection({task:id,conversation:preferredConversation(latest.current,t)?.id});
    // 定位只改变中间业务区域，右侧工具的活动标签与资源独立保留。
    setViewState('tasks');setTaskScreen('tree');
  },[taskQuery,notify]);
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
  const setView=useCallback((next:View)=>{setViewState(next);if(next==='tasks'){setTaskScreen('tree');}},[]);
  // 只在任务树补默认选择；新聊天即使从任务页进入，轮询也不能选回任务并替换草稿。
  useEffect(()=>{if(view==='tasks'&&taskScreen==='tree'&&!latest.current.tasks.some(t=>t.id===currentSelection.current.task)&&data.tasks.length)inspectTask(data.tasks[0].id);},[view,taskScreen,data.tasks,inspectTask]);
  useEffect(()=>{
    // 委托前可能只有任务占位；后台创建主会话后立即展示进度，不要求用户重开任务。
    // 已明确选中的人工会话保持原选择，避免自动主会话抢走用户正在阅读的内容。
    if(selection.conversation||!selection.task)return;
    const selected=data.tasks.find(t=>t.id===selection.task);
    const next=selected&&preferredConversation(data,selected);
    if(!next||!selected)return;
    const sourceKey=`task:${selected.id}`,source=drafts[sourceKey],target=drafts[next.id];
    // 迁移整份草稿（文本、附件和上下文开关）；两边都有草稿时保留当前编辑现场。
    if(hasDraft(source)&&hasDraft(target))return;
    if(hasDraft(source))setDrafts(current=>{
      if(current[sourceKey]!==source)return current;
      const moved={...current,[next.id]:source};delete moved[sourceKey];return moved;
    });
    setSelection(current=>current.task===selected.id&&!current.conversation?{task:selected.id,conversation:next.id}:current);
  },[data.tasks,data.conversations,selection.task,selection.conversation,drafts]);
  const conversation=data.conversations.find(c=>c.id===selection.conversation);
  const task=data.tasks.find(t=>t.id===selection.task||!selection.task&&t.id===conversation?.task_id);
  const draftKey=conversation?.id||(task?`task:${task.id}`:'new-chat');
  const draft=drafts[draftKey]||blankDraft();
  const setDraft=(next:Draft|((value:Draft)=>Draft))=>setDrafts(current=>({...current,[draftKey]:typeof next==='function'?next(current[draftKey]||blankDraft()):next}));
  const saveModelConfig=async(config:ModelConfig)=>{
    // 首次发送前只修改当前草稿，用户选模型不应提前创建任务、会话或执行。
    if(conversation)await command('update_conversation',{conversation_id:conversation.id,revision:conversation.revision,patch:config},'会话设置已保存');
    setDraft(current=>({...current,modelConfig:conversation?undefined:config}));
  };
  const changeProject=(id:string)=>{
    if(conversation)void command('update_conversation',{conversation_id:conversation.id,revision:conversation.revision,patch:{project_id:id}}).catch(()=>{});
    else if(task)setDraft({...draft,projectId:id});else setProjectId(id);
  };
  const send=async()=>{
    const sourceKey=draftKey,captured=draft;let tid=task?.id,cid=conversation?.id,target=conversation;
    const chosen=conversation?.project_id||captured.projectId||task?.effective_project_id||(!task?projectId:'');
    if(!chosen&&!conversation?.config.workspace){notify('先选择一个本地项目；草稿会保留');setDialog(task?{kind:'projectTask',task:task.id}:{kind:'project'});return;}
    try{
      if(!tid){const created=await command<{task_id:string}>('create_task',{title:captured.text.trim().split('\n')[0].slice(0,100)||captured.attachments[0]?.name||'新任务',project_id:chosen});tid=created.task_id;setSelection({task:tid});}
      if(!cid){target=await command<Conversation>('create_conversation',{task_id:tid,project_id:chosen});cid=target.id;setSelection({task:tid,conversation:cid});}
      // 模型保存成功后才能发送；失败保留整份草稿，重试仍先应用选定配置。
      if(captured.modelConfig&&target)await command('update_conversation',{conversation_id:cid,revision:target.revision,patch:captured.modelConfig});
      const content=[captured.text,...captured.attachments.filter(a=>a.text!=null).map(a=>`\n以下是用户附加文件「${a.name}」的内容（引用材料）：\n${a.text}`)].filter(Boolean).join('\n');
      await command('send',{conversation_id:cid,text:content,attachments:captured.attachments.flatMap(a=>a.input?[a.input]:[]),import_context:captured.importContext,expected_run_id:conversation?.current_run_id??null});
      setDrafts(current=>current[sourceKey]===captured||!current[sourceKey]?{...current,[sourceKey]:blankDraft(),[cid!]:blankDraft()}:current);
    }catch{if(cid&&cid!==sourceKey)setDrafts(current=>{
      // 首次创建后的失败草稿移到会话，避免重试成功后“新聊天”复活已发送内容。
      // 两端若有后续编辑则保留新内容，不用发送前的快照覆盖用户输入。
      const targetDraft=current[cid!];
      if(hasDraft(targetDraft)&&targetDraft!==captured){
        // 新输入仍属于用户已选模型的会话；未另选模型时补回失败的配置，重试不能降回默认模型。
        return captured.modelConfig&&!targetDraft.modelConfig?{...current,[cid!]:{...targetDraft,modelConfig:captured.modelConfig}}:current;
      }
      const moved={...current,[cid!]:captured};
      if(current[sourceKey]===captured)delete moved[sourceKey];
      return moved;
    });}
  };
  const newChat=()=>{setSelection({});if(view==='tasks')setTaskScreen('conversation');else setViewState('chat');};
  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{if(!(e.metaKey||e.ctrlKey))return;if(e.key==='1'){e.preventDefault();setView('tasks');}else if(e.key==='2'){e.preventDefault();setView('chat');}};
    document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);
  },[setView]);
  const context={taskQuery,setTaskQuery,api,data,detail,task,conversation,view,panel,setPanel,panelRevision,inspectorOpen,inspectorTab,setInspectorOpen,overlayOpen:Boolean(dialog),toolRequest,openTool,openDialog:setDialog,setView,openTask,openConversation,locateTask,taskReveal,completeTaskReveal,inspectTask,changeTaskState,newConversation,refresh,command,notify,busy:busyCount>0};
  const conversationVisible=view==='chat'||view==='tasks'&&taskScreen==='conversation';
  useEffect(()=>setInspectorOpen(false),[selection.task,selection.conversation,conversationVisible]);
  const attentionCount=data.conversations.filter(c=>needsUser(c,data)&&!c.closed).length;
  return <StudioContext.Provider value={context}><div className={`studio studio-app ${showSidebar?'navigation-expanded':'navigation-collapsed'}`}>
    <WorkspaceHeader conversationVisible={conversationVisible} sidebarVisible={showSidebar} onToggleSidebar={()=>setShowSidebar(x=>!x)} onToolHost={setToolHost}/>
    <div className="frame"><nav className="rail" aria-label="主导航">
      {([{id:'tasks',icon:ListTree,label:'任务'},{id:'chat',icon:MessageSquare,label:'会话'},{id:'projects',icon:Folder,label:'项目'},{id:'attention',icon:Bell,label:'需要你'}] as const).map(item=><button key={item.id} className={`rbtn ${view===item.id?'active':''}`} title={item.label} aria-label={item.label} aria-current={view===item.id?'page':undefined} onClick={()=>setView(item.id)}><item.icon size={19}/>{item.id==='attention'&&attentionCount>0&&<span className="tiny-dot"/>}</button>)}
      <div className="spacer"/><button className={`rbtn ${view==='settings'?'active':''}`} title="设置" aria-label="设置" aria-current={view==='settings'?'page':undefined} onClick={()=>setView('settings')}><Settings2 size={19}/></button><div className="avatar" title="个人工作区">我</div>
    </nav>
    {showSidebar&&<Sidebar loading={loading} onNewChat={newChat} onAllTasks={()=>{setTaskScreen('tree');}}/>}
    <main className="main">{error&&<div className="workspace-error" role="alert"><AlertCircle size={15}/><span>{error}</span><button className="textbtn" onClick={()=>void refresh().catch(e=>setError(String(e)))}>重试</button></div>}
      <div className="content-split" hidden={!conversationVisible&&view!=='tasks'}><div className="work-center"><div className={`center-content ${conversationVisible?'conversation-content':'tree-content'}`}>{conversationVisible?<ChatSurface draftKey={draftKey} draft={draft} setDraft={setDraft} onSend={send} projectId={draft.projectId||task?.effective_project_id||projectId} setProject={changeProject}/>:view==='tasks'?<TaskTree/>:null}<TaskDetails conversationVisible={conversationVisible}/></div></div><RightDock headerHost={toolHost} available={conversationVisible}/></div>
      {!conversationVisible&&view!=='tasks'&&(view==='projects'?<ProjectsPage onSelect={id=>{setTaskQuery(q=>({...q,projects:[id],collapsed:[],page:0,scroll:0}));setTaskScreen('tree');setViewState('tasks');}}/>:view==='attention'?<AttentionPage/>:<SettingsPage/>)}
    </main></div>
    {notice&&<div className="studio-toast show" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={13}/></button></div>}
    {dialog&&<Dialogs key={JSON.stringify(dialog)} dialog={dialog} modelConfig={draft.modelConfig} onSaveModel={saveModelConfig} onClose={()=>setDialog(null)} onImport={key=>setDrafts(current=>({...current,[key]:{...(current[key]||blankDraft()),importContext:true}}))} onNewProject={id=>{setProjectId(id);if(task&&!conversation)setDraft({...draft,projectId:id});}}/>}
  </div></StudioContext.Provider>;
}
