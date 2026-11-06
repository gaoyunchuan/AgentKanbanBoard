import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Plus, Square, X, Folder, Monitor, Shield, ChevronDown, MessageSquare, FileText, Copy, ArrowUpRight, Terminal, LoaderCircle, CircleCheck, Clock, Paperclip, AlertCircle, Layers } from "lucide-react";
import { useStudio, type Draft } from "./context";
import { ProjectPicker } from "./ProjectPicker";
import { Markdown } from "./components";
import { isBusy, runtimeLabel, conversationRecoveryReason, type Conversation } from "./model";
import {useConversationRead} from "./useConversationRead";
import { executionTimeline } from "../workbench/events";
import {ChatTranscript} from "./ChatTranscript";
import { InteractionCard } from "../workbench/InteractionCard";
import { isCurrentInteraction } from "../workbench/types";
import { permissionLabel } from './permissions';
import { attachmentImage, clipboardImages, useComposerAttachments } from "./useComposerAttachments";

import {useConversationHistory} from './useConversationHistory';
import {ConversationHistory} from './ConversationHistory';
import {CodexHistory} from './CodexHistory';

export function ChatSurface({ draft, setDraft, onSend, projectId, setProject, draftKey }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>>; onSend: () => Promise<boolean | void>; projectId: string; setProject: (id: string) => void; draftKey: string }) {
  const s = useStudio();
  const t = s.task, c = s.conversation;
  const modelConfig=draft.modelConfig??c?.config;
  const channelModels = s.data.runtime?.channel_models;
  const savedModelUnavailable = Boolean(modelConfig?.model && channelModels && !channelModels.includes(modelConfig.model));
  const defaultModelLabel = s.data.runtime?.account_channel === 'joycode' ? 'JoyCode 默认模型' : 'Codex 默认模型';
  const [sending, setSending] = useState(false);
  const [plus, setPlus] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [reveal, setReveal] = useState<{id:string;sequence:number}>();
  const files = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const { reading, upload } = useComposerAttachments(draftKey, draft, setDraft, s.notify);
  useEffect(() => { composing.current = false; }, [draftKey]);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const [atBottom,setAtBottom]=useState(true);
  const [historicalView, setHistoricalView] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    // 发送确认和切换会话也会替换文本，需要同步恢复输入框高度和滚动位置。
    element.style.height = 'auto';
    if (draft.text) element.style.height = Math.min(element.scrollHeight, 160) + 'px';
    else element.scrollTop = 0;
  }, [draftKey, draft.text]);
  const events = c && s.detail?.conversation.id === c.id ? s.detail?.events || [] : [];
  const shownConversation=c&&s.detail?.conversation.id===c.id?s.detail.conversation:undefined;
  const work = c && s.detail?.conversation.id === c.id ? s.detail?.work : undefined;
  const paged = Boolean(shownConversation && s.detail?.history_paged);
  const history = useConversationHistory(s.api, paged ? c?.id : undefined);
  const pageEvents = history?.page?.events;
  const newestEvent = pageEvents?.[pageEvents.length - 1]?.id ?? 0;
  const historyReady = !paged || (Boolean(history?.page) && newestEvent >= (shownConversation?.last_output_event_id ?? 0));
  useConversationRead(shownConversation,s.readSession??0,atBottom && !historicalView && historyReady,async(boundary,read_version)=>{
    await s.api.call('mark_read',{conversation_id:shownConversation!.id,boundary,read_version});
    await s.refresh();
  },c?.read_version);
  const visibleEvents = history?.page?.events ?? events;
  const timeline = useMemo(() => executionTimeline(visibleEvents), [visibleEvents]);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const closeProjects = () => {setProjectOpen(false);projectTrigger.current?.focus();};
  const selectedProject = s.data.projects.find(p => p.id === (c?.project_id || projectId || t?.effective_project_id));
  const blocked = Boolean(t?.missing_dependencies.length);
  const closed = Boolean(c?.closed || t && ['completed', 'cancelled'].includes(t.status));
  const pending = c && s.detail?.conversation.id === c.id ? s.detail!.interactions.filter(i => c?.mode === 'auto' && work ? isCurrentInteraction(i, work) : i.status === 'pending' && i.run_id === c?.current_run_id) : [];
  const summarizing = Boolean(t?.results.some(r => r.conversation_id === c?.id && r.status === 'pending' && r.method === 'manual'));
  const busy = c ? isBusy(c)&&c.runtime_status!=='recovering' : false;
  const canSend = c?.codex_binding!==false && !['stopping','uncertain'].includes(c?.resource_hold?.state || '') && !blocked && !closed && !pending.length && !summarizing && !['queued', 'stopping','recovering'].includes(c?.runtime_status || '') && (!work || ['queued', 'running'].includes(work.status));
  useEffect(() => { bottom.current = true; setAtBottom(true); setHistoricalView(false); setPlus(false); setProjectOpen(false); setFeedback(''); input.current?.focus(); }, [c?.id, t?.id]);
  useEffect(() => { if (!paged && bottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [timeline.length, timeline[timeline.length - 1]?.text, pending.length, paged]);
  const revealSubmitted = () => {
    if (c) setReveal(previous => ({id:c.id,sequence:(previous?.sequence ?? 0)+1}));
  };
  const send = async () => {
    if (sending || reading || composing.current || !canSend || !draft.text.trim() && !draft.attachments.length) return;
    setSending(true);
    try {
      if (await onSend()) revealSubmitted();
    } finally {
      setSending(false);
    }
  };
  return <section className="chat-area" aria-label="聊天会话">
    {timeline.length || paged || typeof c?.codex_binding==='boolean' ? <div className={paged ? "chat-scroll paged-history" : "chat-scroll"} ref={scroll} onScroll={e => { const el = e.currentTarget; bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setAtBottom(bottom.current); }}><div className="chat-body">
      {c?.mode === 'auto' && <button className="run-event context-link" onClick={() => s.openDialog({ kind: 'context', task: t!.id })}><Layers size={13}/>自动执行 · 查看任务上下文与交付来源<ChevronDown size={12}/></button>}
      {typeof c?.codex_binding==='boolean'&&<CodexHistory key={`codex-history:${c.id}`} conversationId={c.id}/>}
      {paged && c ? <ConversationHistory key={c.id} api={s.api} id={c.id} live={history?.page} error={history?.error}
        scroll={scroll} currentRunId={c.current_run_id} onGap={setHistoricalView} revealLatest={reveal?.id===c.id ? reveal.sequence : 0}/>
        : <ChatTranscript key={c?.id} events={events} runs={s.detail?.runs||[]} currentRunId={c?.current_run_id}/>}
      {pending.map(i => <div className="native-interaction" key={i.id}><InteractionCard interaction={i} disabled={s.busy} onRespond={response => void s.command('respond', { conversation_id: c!.id, interaction_id: i.id, run_id: i.run_id, response }, '已回应，执行继续').then(revealSubmitted).catch(() => {})}/></div>)}
      {work?.status === 'review' && <div className="handoff-card"><div className="handoff-title"><CircleCheck size={16}/>交付已提交，等待验收</div><Markdown text={work.result_summary || '查看任务结果和实际变更后验收。'}/><div className="handoff-links"><button className="textbtn outlined" onClick={() => s.setPanel('results')}>查看来源与结果</button><button className="textbtn primary" disabled={s.busy || Boolean(work.current_run_id)} onClick={() => void s.command('work_action', { task_id: work.task_id, action: 'accept', expected_revision: work.revision }, '验收通过，后续依赖自动推进').catch(() => {})}>验收通过</button></div><label className="feedback-label">需要修改的内容<textarea aria-label="返工反馈" value={feedback} onChange={e => setFeedback(e.target.value)}/></label><button className="textbtn outlined" disabled={!feedback.trim() || s.busy || Boolean(work.current_run_id)} onClick={() => void s.command('work_action', { task_id: work.task_id, action: 'rework', expected_revision: work.revision, feedback }, '已退回修改，历史结果保留').then(revealSubmitted).catch(() => {})}>退回修改</button></div>}
      {c?.last_error && <div className="warning-box"><AlertCircle size={16}/><span style={{whiteSpace:'pre-wrap'}}>{c.last_error}</span>{c.thread_id&&<button className="textbtn" disabled={Boolean(conversationRecoveryReason(c,s.data))||s.busy} onClick={()=>s.openDialog({kind:'recoverConnection',conversation:c.id})}>恢复会话连接</button>}<button className="textbtn" onClick={()=>s.setView('settings')}>连接诊断</button></div>}
      {work && ['paused', 'attention'].includes(work.status) && !closed && <div className="run-event"><span>{work.status === 'attention' ? '本次执行需要核对后继续' : '当前任务已暂停'}</span><button className="textbtn outlined" disabled={s.busy} onClick={() => void s.command('work_action', { task_id: work.task_id, action: work.status === 'attention' ? 'retry' : 'resume', expected_revision: work.revision }, '已恢复任务调度').catch(() => {})}>核对后继续</button></div>}
      {t?.results.some(r => r.conversation_id === c?.id && r.method === 'auto') && <button className="handoff-status" onClick={() => s.setPanel('results')}><FileText size={13}/>交接结果已留存 · 查看来源<ArrowUpRight size={12}/></button>}
      {c && <div className="run-event">{c.runtime_status === 'running' ? <LoaderCircle size={13} className="spin"/> : <CircleCheck size={13}/>}<span>{runtimeLabel(c)}</span></div>}
    </div></div> : <div className="empty"><div className="empty-inner"><div className="empty-symbol"><MessageSquare size={36} strokeWidth={1.2}/></div>{t && <div className="task-name">{t.title}</div>}<h2>{c?.runtime_status==='scheduled' ? '等待开始时间，到时自动检查并执行。' : blocked ? '前置交付就绪后，自动开始。' : <>你想让我们在 <button onClick={() => setProjectOpen(true)}>{selectedProject?.name || '哪个项目'}</button> 中构建什么？</>}</h2>{blocked ? <div className="blocked-empty"><div className="title"><Clock size={15}/>等待 {t!.missing_dependencies.length} 项前置交付</div>{t!.missing_dependencies.map(id => <button key={id} className="dep-link" onClick={() => s.openTask(id)}><LinkIcon/>{s.data.tasks.find(x => x.id === id)?.title || id}<ArrowUpRight size={12}/></button>)}<p>{c?.thread_id ? '保留已有会话，只暂停后续执行。' : '尚未创建真实 Codex Thread，不消耗模型执行。'}</p><button className="textbtn" onClick={() => s.openDialog({ kind: 'dependencies', task: t!.id })}>调整前置任务</button></div> : c?.mode === 'auto' ? <p>{t?.scheduled_start_at?`最早开始：${new Date(t.scheduled_start_at).toLocaleString('zh-CN')}。`:''}任务已委托；时间、项目、执行容量和依赖全部就绪后自动开始。</p> : <p>直接聊天。任务属性和结果在右侧按需打开。</p>}</div></div>}
    <div className="composer-wrap"><div className="composer-container">
      {c?.codex_binding===false&&<div className="codex-handoff"><div className="grow"><strong>等待会话交接</strong><p>先在 Codex 确认执行已结束并归档原会话，再回到这里恢复连接。草稿会保留。</p></div><button className="textbtn outlined" disabled={s.busy||Boolean(conversationRecoveryReason(c,s.data))} onClick={()=>s.openDialog({kind:'recoverConnection',conversation:c.id})}>归档交接并接续</button></div>}
      {c?.resource_hold?.state==='uncertain' && <div role="alert" className="closed-notice"><AlertCircle size={15}/><span>原生命令退出尚未确认，工作目录仍被占用。{c.resource_hold.error}</span><button className="textbtn outlined" disabled={s.busy} onClick={()=>void s.command('release_resources',{conversation_id:c.id,run_id:c.resource_hold!.run_id},'已解除核对过的占用；不会自动重放旧操作').catch(()=>{})}>已核对进程停止，解除占用</button></div>}

      {closed ? <div className="closed-notice"><CircleCheck size={15}/><span>{c?.closed ? `${c.title} · 已完成` : '任务已结束'} · 历史消息与结果保留</span>{t && ['completed', 'cancelled'].includes(t.status) ? <button className="textbtn outlined" onClick={() => void s.command('task_state', { task_id: t.id, state: 'reopen' }, '任务已重新打开').catch(() => {})}>重新打开任务</button> : c && <button className="textbtn outlined" onClick={() => void s.command('reopen_conversation', { conversation_id: c.id }).catch(() => {})}>恢复此会话</button>}</div> : <>
        <div className="composer-meta"><div className="menu-anchor"><button ref={projectTrigger} aria-expanded={projectOpen} aria-haspopup="listbox" disabled={Boolean(c?.thread_id)} title={c?.thread_id ? `真实会话目录已固定：${c.config.workspace}` : '选择会话项目'} onClick={() => setProjectOpen(!projectOpen)} onKeyDown={e => {if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();setProjectOpen(true);}}}><Folder size={12}/><span className="truncate">{selectedProject?.name || '选择项目'}</span><ChevronDown size={11}/></button>{projectOpen && <div className="inline-menu composer-menu"><div className="pop-label">{c?.thread_id ? '当前会话目录已固定' : '新会话的项目'}</div><ProjectPicker projects={s.data.projects} selected={selectedProject?.id} compact onClose={closeProjects} onSelect={id => { setProject(id); closeProjects(); }} onAdd={() => {s.openDialog({kind:'project'});setProjectOpen(false);}}/></div>}</div><span className="meta-divider"/><Monitor size={12}/><span>此计算机</span><span className="grow"/>{c?.mode === 'auto' && <button onClick={() => s.openDialog({ kind: 'context', task: t!.id })}><Layers size={12}/>自动带入上下文</button>}</div>
        <div className="composer">{draft.importContext || draft.attachments.length ? <div className="attachment-chips">{draft.importContext && <span className="attachment-chip"><Layers size={12}/>任务上下文<button aria-label="移除任务上下文" onClick={() => setDraft({ ...draft, importContext: false })}><X size={11}/></button></span>}{draft.attachments.map((a, i) => <span className="attachment-chip" key={i}><>{attachmentImage(a.input) ? <img className="attachment-thumbnail" src={attachmentImage(a.input)} alt={a.name}/> : <Paperclip size={12}/>}<span className="attachment-name">{a.name}</span></><button aria-label={`移除 ${a.name}`} onClick={() => setDraft({ ...draft, attachments: draft.attachments.filter((_, n) => n !== i) })}><X size={11}/></button></span>)}</div> : null}
          {reading && <div className="compose-wait" role="status"><LoaderCircle size={12} className="spin"/>正在读取附件…</div>}{blocked && <div className="compose-wait"><Clock size={12}/>等待前置任务；可保留草稿，不会提前启动。</div>}{summarizing && <div className="compose-wait"><LoaderCircle size={12} className="spin"/>正在整理结果。草稿保留，整理完成后可继续。</div>}
          <textarea ref={input} aria-label="聊天输入" placeholder="随心输入" value={draft.text} onChange={e => { const text = e.target.value; setDraft(current => ({ ...current, text })); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onPaste={e => { const images = clipboardImages(e.clipboardData); if (images.length) { e.preventDefault(); void upload(images); } }} onKeyDown={e => {
            // WebKit 的确认键可能晚于 compositionend，仍用 229 标记输入法事件。
            if (composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}/>
          <div className="composer-toolbar"><div className="menu-anchor"><button className="iconbtn" aria-label="添加上下文或附件" onClick={() => setPlus(!plus)}><Plus size={19}/></button>{plus && <div className="inline-menu composer-menu"><button className="popitem" disabled={!t} onClick={() => { if (t) s.openDialog({ kind: 'context', task: t.id, importTo: draftKey }); setPlus(false); }}><Layers size={14}/>导入任务上下文</button><button className="popitem" onClick={() => { files.current?.click(); setPlus(false); }}><Paperclip size={14}/>添加文本或图片</button></div>}</div><button className="permissions" onClick={() => !c&&t?s.setPanel('properties'):s.openDialog({ kind: 'permissions' })}><Shield size={13}/>{permissionLabel(c?.config??t?.execution_permissions)}</button><button className="model-btn" title={savedModelUnavailable ? `已保存的 ${modelConfig?.model} 在当前账户不可用，本轮使用默认模型` : undefined} onClick={() => s.openDialog({ kind: 'models' })}>{(!savedModelUnavailable && modelConfig?.model) || defaultModelLabel}{!savedModelUnavailable && modelConfig?.reasoning_effort ? ` · ${modelConfig.reasoning_effort}` : ''}<ChevronDown size={11}/></button>{busy ? <button className="send stop" aria-label="停止当前执行" title="停止当前执行，不完成任务" disabled={c?.runtime_status === 'stopping' || s.busy} onClick={() => void s.command('stop', { conversation_id: c!.id }, '停止请求已发送，等待确认').catch(() => {})}><Square size={13} fill="currentColor"/></button> : <button className="send" aria-label="发送消息" title="Enter 发送，Shift+Enter 换行" disabled={!canSend || sending || reading || s.busy || !draft.text.trim() && !draft.attachments.length} onClick={() => void send()}>{sending ? <LoaderCircle size={16} className="spin"/> : <ArrowUp size={17}/>}</button>}</div>
        </div><div className="composer-foot">{c?.thread_id ? '本轮结束不等于任务完成。' : '发送后才创建真实 Codex 会话。'} {s.api.native ? '' : '浏览器演示，不连接真实模型。'}</div>
      </>}
    </div></div><input ref={files} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.md,.txt,.json,.yaml,.yml,.toml,.rs,.go,.ts,.tsx,.py,.sh,.sql,.log" onChange={e => { const selected = Array.from(e.target.files || []); e.target.value = ''; void upload(selected); }}/>
  </section>;
}
function LinkIcon() { return <Clock size={12}/>; }
