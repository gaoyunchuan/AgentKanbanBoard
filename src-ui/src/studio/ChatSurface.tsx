import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUp, Plus, Square, X, Folder, Monitor, Shield, ChevronDown, MessageSquare, ListTree, PanelRight, Globe, FileText, Copy, ArrowUpRight, GitPullRequest, Terminal, LoaderCircle, CircleCheck, Clock, Paperclip, AlertCircle, Layers, Check } from "lucide-react";
import { useStudio, type Draft } from "./context";
import { Markdown } from "./components";
import { taskConversations, ancestors, isBusy, runtimeLabel, type Conversation } from "./model";
import { executionTimeline, executionDiff } from "../workbench/events";
import { InteractionCard } from "../workbench/TaskExecutionPanel";
import { isCurrentInteraction, type WorkTask } from "../workbench/types";
import { WorkspacePanel } from "../workbench/WorkspacePanel";
import { BrowserPane } from "./BrowserPane";

export function ConversationHeader() {
  const s = useStudio();
  const [switching, setSwitching] = useState(false);
  const t = s.task, c = s.conversation;
  const all = t ? taskConversations(s.data, t.id) : [];
  return <header className="main-head chat-head"><div className="head-title">{t && <div className="header-context"><button className="crumb" onClick={() => s.locateTask(t.id)}><ListTree size={12}/><span>{[...ancestors(s.data.tasks, t.id).map(x => x.title), t.title].join(' / ')}</span></button><div className="title-with-switch"><h1>{c?.title || t.title}</h1>{all.length > 0 && <div className="menu-anchor"><button className="iconbtn" aria-label="切换本任务会话" aria-expanded={switching} onClick={() => setSwitching(!switching)}><ChevronDown size={14}/></button>{switching && <div className="inline-menu"><div className="pop-label">本任务的 {all.length} 个会话 · 非子任务</div>{all.map(x => <button className="popitem" key={x.id} onClick={() => { s.openConversation(x.id); setSwitching(false); }}><MessageSquare size={13}/><span className="truncate grow">{x.title}</span>{x.id === c?.id && <Check size={12}/>}</button>)}<button className="popitem" onClick={() => { void s.newConversation(t.id); setSwitching(false); }}><Plus size={14}/>新建会话</button></div>}</div>}</div></div>}</div>{t && <div className="header-actions"><button className="iconbtn" aria-label="新建本任务会话" title="新建本任务会话（不是子任务）" disabled={s.busy || ['completed', 'cancelled'].includes(t.status)} onClick={() => void s.newConversation(t.id)}><Plus size={16}/></button><button className="textbtn" title="提取当前会话结果并追加到任务" disabled={!c?.thread_id || isBusy(c) || s.busy || t.results.some(r => r.conversation_id === c.id && r.status === 'pending')} onClick={() => { if (c) void s.command('extract', { conversation_id: c.id }, '正在整理结果，原业务操作不会重跑').then(() => s.setPanel('results')).catch(() => {}); }}><FileText size={15}/><span className="extract-label">提取结果</span></button><button className={`iconbtn ${s.panel === 'diff' ? 'selected' : ''}`} title="本轮变更" aria-label="变更" onClick={() => s.setPanel(s.panel === 'diff' ? null : 'diff')}><GitPullRequest size={16}/></button><button className={`iconbtn ${s.panel === 'workspace' ? 'selected' : ''}`} title="文件与终端" aria-label="文件与终端" onClick={() => s.setPanel(s.panel === 'workspace' ? null : 'workspace')}><Terminal size={16}/></button><button className={`iconbtn ${s.panel === 'browser' ? 'selected' : ''}`} title="侧边浏览器" aria-label="侧边浏览器" onClick={() => s.setPanel(s.panel === 'browser' ? null : 'browser')}><Globe size={16}/></button><button className={`iconbtn ${['properties', 'context', 'results'].includes(s.panel || '') ? 'selected' : ''}`} aria-label="任务详情" title="任务详情" onClick={() => s.setPanel(s.panel === 'properties' ? null : 'properties')}><PanelRight size={16}/></button></div>}</header>;
}

export function ChatSurface({ draft, setDraft, onSend, projectId, setProject, draftKey }: { draft: Draft; setDraft: (value: Draft) => void; onSend: () => Promise<void>; projectId: string; setProject: (id: string) => void; draftKey: string }) {
  const s = useStudio();
  const t = s.task, c = s.conversation;
  const [sending, setSending] = useState(false);
  const [plus, setPlus] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const events = c && s.detail?.conversation.id === c.id ? s.detail?.events || [] : [];
  const work = c && s.detail?.conversation.id === c.id ? s.detail?.work : undefined;
  const timeline = useMemo(() => executionTimeline(events), [events]);
  const selectedProject = s.data.projects.find(p => p.id === (c?.project_id || projectId || t?.effective_project_id));
  const blocked = Boolean(t?.missing_dependencies.length);
  const closed = Boolean(c?.closed || t && ['completed', 'cancelled'].includes(t.status));
  const pending = c && s.detail?.conversation.id === c.id ? s.detail!.interactions.filter(i => c?.mode === 'auto' && work ? isCurrentInteraction(i, work) : i.status === 'pending' && i.run_id === c?.current_run_id) : [];
  const summarizing = Boolean(t?.results.some(r => r.conversation_id === c?.id && r.status === 'pending' && r.method === 'manual'));
  const busy = c ? isBusy(c) : false;
  const canSend = !blocked && !closed && !pending.length && !summarizing && !['queued', 'stopping'].includes(c?.runtime_status || '') && (!work || ['queued', 'running'].includes(work.status));
  useEffect(() => { bottom.current = true; setPlus(false); setProjectOpen(false); setFeedback(''); input.current?.focus(); }, [c?.id, t?.id]);
  useEffect(() => { if (bottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [timeline.length, timeline[timeline.length - 1]?.text, pending.length]);
  const send = async () => { if (sending || !canSend || !draft.text.trim() && !draft.attachments.length) return; setSending(true); try { await onSend(); } finally { setSending(false); } };
  const upload = async (list: FileList | null) => {
    if (!list) return;
    const captured = draftKey;
    const additions: Draft['attachments'] = [];
    try {
      for (const file of Array.from(list)) {
        if (file.size > 4_000_000) throw new Error(`${file.name} 超过 4 MB，请按范围引用文件`);
        if (file.type.startsWith('image/')) {
          if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('图片支持 PNG、JPEG、WebP 和 GIF');
          const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
          additions.push({ name: file.name, input: { type: 'image', url } });
        } else if (/\.(md|txt|json|ya?ml|toml|rs|go|tsx?|jsx?|py|sh|sql|log|css|html)$/i.test(file.name)) additions.push({ name: file.name, text: await file.text() });
        else throw new Error('此文件暂不直接解析，请选用文本/Markdown或图片，或在消息中引用项目内路径');
      }
      if (draftKey !== captured) return;
      if (draft.attachments.length + additions.length > 16) throw new Error('每条消息最多 16 个附件');
      setDraft({ ...draft, attachments: [...draft.attachments, ...additions] });
    } catch (e) { s.notify(String(e)); }
    if (files.current) files.current.value = '';
  };
  return <section className="chat-area" aria-label="聊天会话">
    {timeline.length ? <div className="chat-scroll" ref={scroll} onScroll={e => { const el = e.currentTarget; bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}><div className="chat-body">
      {c?.mode === 'auto' && <button className="run-event context-link" onClick={() => s.openDialog({ kind: 'context', task: t!.id })}><Layers size={13}/>自动执行 · 查看任务上下文与交付来源<ChevronDown size={12}/></button>}
      {timeline.map(item => item.role === 'tool' ? <details className="tool-event" key={item.id}><summary><Terminal size={13}/><span className="truncate">{item.title || '工具调用'}</span><span className="muted">{item.status}</span></summary><pre>{item.text}</pre>{item.images?.map((src, n) => <img src={src} key={n} alt="工具返回的图片"/>)}</details> : <div className={`message ${item.role === 'user' ? 'user' : 'assistant'}`} key={item.id}>{item.role !== 'user' && <div className="assistant-name"><MessageSquare size={14}/>Codex</div>}<div className={item.role === 'user' ? 'bubble' : ''}><Markdown text={item.text}/></div>{item.role !== 'user' && <div className="msg-actions"><button title="复制内容" aria-label="复制回答" onClick={() => void navigator.clipboard.writeText(item.text).then(() => s.notify('已复制')).catch(() => s.notify('复制失败，请手动选择文本'))}><Copy size={13}/></button></div>}</div>)}
      {pending.map(i => <div className="native-interaction" key={i.id}><InteractionCard interaction={i} disabled={s.busy} onRespond={response => void s.command('respond', { conversation_id: c!.id, interaction_id: i.id, run_id: i.run_id, response }, '已回应，执行继续').catch(() => {})}/></div>)}
      {work?.status === 'review' && <div className="handoff-card"><div className="handoff-title"><CircleCheck size={16}/>交付已提交，等待验收</div><Markdown text={work.result_summary || '查看任务结果和实际变更后验收。'}/><div className="handoff-links"><button className="textbtn outlined" onClick={() => s.setPanel('results')}>查看来源与结果</button><button className="textbtn primary" disabled={s.busy || Boolean(work.current_run_id)} onClick={() => void s.command('work_action', { task_id: work.task_id, action: 'accept', expected_revision: work.revision }, '验收通过，后续依赖自动推进').catch(() => {})}>验收通过</button></div><label className="feedback-label">需要修改的内容<textarea aria-label="返工反馈" value={feedback} onChange={e => setFeedback(e.target.value)}/></label><button className="textbtn outlined" disabled={!feedback.trim() || s.busy || Boolean(work.current_run_id)} onClick={() => void s.command('work_action', { task_id: work.task_id, action: 'rework', expected_revision: work.revision, feedback }, '已退回修改，历史结果保留').catch(() => {})}>退回修改</button></div>}
      {c?.last_error && <div className="warning-box"><AlertCircle size={16}/><span>{c.last_error}</span></div>}
      {work && ['paused', 'attention'].includes(work.status) && !closed && <div className="run-event"><span>{work.status === 'attention' ? '本次执行需要核对后继续' : '当前任务已暂停'}</span><button className="textbtn outlined" disabled={s.busy} onClick={() => void s.command('work_action', { task_id: work.task_id, action: work.status === 'attention' ? 'retry' : 'resume', expected_revision: work.revision }, '已恢复任务调度').catch(() => {})}>核对后继续</button></div>}
      {t?.results.some(r => r.conversation_id === c?.id && r.method === 'auto') && <button className="handoff-status" onClick={() => s.setPanel('results')}><FileText size={13}/>交接结果已留存 · 查看来源<ArrowUpRight size={12}/></button>}
      {c && <div className="run-event">{c.runtime_status === 'running' ? <LoaderCircle size={13} className="spin"/> : <CircleCheck size={13}/>}<span>{runtimeLabel(c)}</span></div>}
    </div></div> : <div className="empty"><div className="empty-inner"><div className="empty-symbol"><MessageSquare size={36} strokeWidth={1.2}/></div>{t && <div className="task-name">{t.title}</div>}<h2>{blocked ? '前置交付就绪后，自动开始。' : <>你想让我们在 <button onClick={() => setProjectOpen(true)}>{selectedProject?.name || '哪个项目'}</button> 中构建什么？</>}</h2>{blocked ? <div className="blocked-empty"><div className="title"><Clock size={15}/>等待 {t!.missing_dependencies.length} 项前置交付</div>{t!.missing_dependencies.map(id => <button key={id} className="dep-link" onClick={() => s.openTask(id)}><LinkIcon/>{s.data.tasks.find(x => x.id === id)?.title || id}<ArrowUpRight size={12}/></button>)}<p>{c?.thread_id ? '保留已有会话，只暂停后续执行。' : '尚未创建真实 Codex Thread，不消耗模型执行。'}</p><button className="textbtn" onClick={() => s.openDialog({ kind: 'dependencies', task: t!.id })}>调整前置任务</button></div> : c?.mode === 'auto' ? <p>任务已委托；项目、执行容量和依赖就绪后，由系统带上上下文开始。</p> : <p>直接聊天。任务属性和结果在右侧按需打开。</p>}</div></div>}
    <div className="composer-wrap"><div className="composer-container">
      {closed ? <div className="closed-notice"><CircleCheck size={15}/><span>已完成 · 历史消息与结果保留</span>{t && ['completed', 'cancelled'].includes(t.status) ? <button className="textbtn outlined" onClick={() => void s.command('task_state', { task_id: t.id, state: 'reopen' }, '任务已重新打开').catch(() => {})}>重新打开任务</button> : c && <button className="textbtn outlined" onClick={() => void s.command('reopen_conversation', { conversation_id: c.id }).catch(() => {})}>恢复此会话</button>}</div> : <>
        <div className="composer-meta"><div className="menu-anchor"><button disabled={Boolean(c?.thread_id)} title={c?.thread_id ? `真实会话目录已固定：${c.config.workspace}` : '选择会话项目'} onClick={() => setProjectOpen(!projectOpen)}><Folder size={12}/><span className="truncate">{selectedProject?.name || '选择项目'}</span><ChevronDown size={11}/></button>{projectOpen && <div className="inline-menu composer-menu"><div className="pop-label">{c?.thread_id ? '当前会话目录已固定' : '新会话的项目'}</div>{s.data.projects.map(p => <button key={p.id} className="popitem" onClick={() => { setProject(p.id); setProjectOpen(false); }}><Folder size={13}/><span className="truncate grow">{p.name}</span>{p.id === selectedProject?.id && <Check size={12}/>}</button>)}<button className="popitem" onClick={() => { s.openDialog({ kind: 'project' }); setProjectOpen(false); }}><Plus size={13}/>添加本地项目</button></div>}</div><span className="meta-divider"/><Monitor size={12}/><span>此计算机</span><span className="grow"/>{c?.mode === 'auto' && <button onClick={() => s.openDialog({ kind: 'context', task: t!.id })}><Layers size={12}/>自动带入上下文</button>}</div>
        <div className="composer">{draft.importContext || draft.attachments.length ? <div className="attachment-chips">{draft.importContext && <span className="attachment-chip"><Layers size={12}/>任务上下文<button aria-label="移除任务上下文" onClick={() => setDraft({ ...draft, importContext: false })}><X size={11}/></button></span>}{draft.attachments.map((a, i) => <span className="attachment-chip" key={i}><Paperclip size={12}/>{a.name}<button aria-label={`移除 ${a.name}`} onClick={() => setDraft({ ...draft, attachments: draft.attachments.filter((_, n) => n !== i) })}><X size={11}/></button></span>)}</div> : null}
          {blocked && <div className="compose-wait"><Clock size={12}/>等待前置任务；可保留草稿，不会提前启动。</div>}{summarizing && <div className="compose-wait"><LoaderCircle size={12} className="spin"/>正在整理结果。草稿保留，整理完成后可继续。</div>}
          <textarea ref={input} aria-label="聊天输入" placeholder="随心输入" value={draft.text} onChange={e => { setDraft({ ...draft, text: e.target.value }); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/>
          <div className="composer-toolbar"><div className="menu-anchor"><button className="iconbtn" aria-label="添加上下文或附件" onClick={() => setPlus(!plus)}><Plus size={19}/></button>{plus && <div className="inline-menu composer-menu"><button className="popitem" disabled={!t} onClick={() => { if (t) s.openDialog({ kind: 'context', task: t.id, importTo: draftKey }); setPlus(false); }}><Layers size={14}/>导入任务上下文</button><button className="popitem" onClick={() => { files.current?.click(); setPlus(false); }}><Paperclip size={14}/>添加文本或图片</button></div>}</div><button className="permissions" onClick={() => s.openDialog({ kind: 'permissions' })}><Shield size={13}/>{c?.config.sandbox_mode === 'read-only' ? '只读' : c?.config.sandbox_mode === 'danger-full-access' ? '完全访问' : '按需确认'}</button><button className="model-btn" onClick={() => s.openDialog({ kind: 'models' })}>{c?.config.model || 'Codex 默认模型'}{c?.config.reasoning_effort ? ` · ${c.config.reasoning_effort}` : ''}<ChevronDown size={11}/></button>{busy ? <button className="send stop" aria-label="停止当前执行" title="停止当前执行，不完成任务" disabled={c?.runtime_status === 'stopping' || s.busy} onClick={() => void s.command('stop', { conversation_id: c!.id }, '停止请求已发送，等待确认').catch(() => {})}><Square size={13} fill="currentColor"/></button> : <button className="send" aria-label="发送消息" title="Enter 发送，Shift+Enter 换行" disabled={!canSend || sending || s.busy || !draft.text.trim() && !draft.attachments.length} onClick={() => void send()}>{sending ? <LoaderCircle size={16} className="spin"/> : <ArrowUp size={17}/>}</button>}</div>
        </div><div className="composer-foot">{c?.thread_id ? '本轮结束不等于任务完成。' : '发送后才创建真实 Codex 会话。'} {s.api.native ? '' : '浏览器演示，不连接真实模型。'}</div>
      </>}
    </div></div><input ref={files} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.md,.txt,.json,.yaml,.yml,.toml,.rs,.go,.ts,.tsx,.py,.sh,.sql,.log" onChange={e => void upload(e.target.files)}/>
  </section>;
}
function LinkIcon() { return <Clock size={12}/>; }
export function UtilityPanel() {
  const s = useStudio(), c = s.conversation;
  if (s.panel === 'browser') return <BrowserPane/>;
  const workspaceTask: WorkTask | undefined = c ? { task_id: `conversation:${c.id}`, title: c.title, status: 'paused', execution_status: c.runtime_status, revision: c.revision, config: c.config, continuation_count: 0, updated_at: c.updated_at } : undefined;
  return <aside className="inspector utility-panel" aria-label={s.panel === 'diff' ? '变更面板' : '工作区面板'}><div className="inspector-head">{s.panel === 'diff' ? '当前会话变更' : '文件与终端'}<button className="iconbtn" aria-label="关闭工具面板" onClick={() => s.setPanel(null)}><X size={16}/></button></div><div className="inspector-body">{s.panel === 'diff' ? <pre className="diff-preview">{executionDiff(s.detail?.events || []) || '本会话还没有返回 Diff。可通过文件与终端检查实际 Git 改动。'}</pre> : c ? <WorkspacePanel key={c.id} task={workspaceTask} events={s.detail?.events || []} enabled={s.api.native}/> : <p className="note">先选择一个会话。</p>}</div></aside>;
}
