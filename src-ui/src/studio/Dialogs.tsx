import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, Check, Clock, Link, ArrowUpRight, AlertCircle } from "lucide-react";
import { Modal, Markdown } from "./components";
import { useStudio, type DialogState } from "./context";
import { ancestors, rootId, flattenedTasks, dependencyReason, isBusy, taskLabel } from "./model";
import { ProjectPicker } from "./ProjectPicker";
import { record } from "../workbench/events";

type Props = { dialog: DialogState; onClose: () => void; onImport: (key: string) => void; onNewProject?: (id: string) => void };
export function Dialogs({ dialog, onClose, onImport, onNewProject }: Props) {
  const s = useStudio();
  const tid = 'task' in dialog ? dialog.task : s.task?.id;
  const task = s.data.tasks.find(t => t.id === tid);
  const c = dialog.kind === 'renameConversation' ? s.data.conversations.find(c => c.id === dialog.conversation) : s.conversation;
  const [text, setText] = useState(dialog.kind === 'renameConversation' ? c?.title ?? '' : '');
  const [project, setProject] = useState(task?.project_id ?? '');
  const [path, setPath] = useState('');
  const [deps, setDeps] = useState<string[]>(task?.blocked_by ?? []);
  const [initialDeps] = useState(task?.blocked_by ?? []);
  const [search, setSearch] = useState('');
  const [context, setContext] = useState<Record<string, unknown>>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [model, setModel] = useState(c?.config.model ?? '');
  const [effort, setEffort] = useState(c?.config.reasoning_effort ?? '');
  const [sandbox, setSandbox] = useState(c?.config.sandbox_mode ?? 'workspace-write');
  const [approval, setApproval] = useState(c?.config.approval_policy ?? 'on-request');
  const [acknowledged, setAcknowledged] = useState(false);
  const act = async (fn: () => Promise<unknown>, close = true) => { if (busy) return; setBusy(true); setErr(undefined); try { await fn(); if (close) onClose(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };
  useEffect(() => {
    let valid = true;
    if (dialog.kind === 'context' && task) void s.api.call<Record<string, unknown>>('context', { task_id: task.id }).then(x => { if (valid) setContext(x); }).catch(e => { if (valid) setErr(String(e)); });
    if (dialog.kind === 'deleted') void s.api.call<Record<string, unknown>[]>('deleted').then(x => { if (valid) setItems(x); }).catch(e => { if (valid) setErr(String(e)); });
    if (dialog.kind === 'models' && s.api.native) void invoke('workbench_rpc', { method: 'model/list', params: {} }).then(x => { const values = record(x).data; if (valid && Array.isArray(values)) setItems(values.map(record)); }).catch(e => { if (valid) setErr(String(e)); });
    if (dialog.kind === 'project' && dialog.id) { const p = s.data.projects.find(p => p.id === dialog.id); setText(p?.name ?? ''); setPath(p?.path ?? ''); }
    return () => { valid = false; };
  }, [dialog]);
  const cancel = <button className="textbtn outlined" disabled={busy} onClick={onClose}>取消</button>;
  const error = err ? <p className="form-error" role="alert">{err}</p> : null;
  const submit = (label: string, handler: () => Promise<unknown>, disabled = false) => <button className="textbtn primary" disabled={busy || disabled} onClick={() => void act(handler)}>{busy ? '处理中…' : label}</button>;
  if (dialog.kind === 'createTask' || dialog.kind === 'renameConversation') {
    const creating = dialog.kind === 'createTask';
    const parent = creating && dialog.parent ? s.data.tasks.find(t => t.id === dialog.parent) : undefined;
    return <Modal title={creating ? parent ? '添加子任务' : '新建任务' : '重命名'} onClose={onClose} footer={<>{cancel}{submit(creating ? '创建任务' : '保存', async () => {
      if (creating) { const result = await s.command<{ task_id: string }>('create_task', { title: text.trim(), parent_id: dialog.parent ?? null, project_id: project || null }); s.openTask(result.task_id); }
      else if (c) await s.command('update_conversation', { conversation_id: c.id, revision: c.revision, patch: { title: text.trim() } });
    }, !text.trim())}</>}>
      <p className="modal-desc">{creating ? parent ? `属于「${parent.title}」。仅创建标题，不会立即启动 Agent。` : '一个标题就可以开始。项目和其他属性随时可补充。' : '只更改显示名称，保留已有会话、结果和关联。'}</p>
      <label htmlFor="item-title">标题</label><input id="item-title" value={text} onChange={e => setText(e.target.value)} maxLength={500} autoFocus onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.closest('.modal')?.querySelector<HTMLButtonElement>('.modal-footer .primary')?.click(); }}/>
      {creating && <><label htmlFor="task-project">默认项目 · 可选</label><select id="task-project" value={project} onChange={e => setProject(e.target.value)}><option value="">{parent ? '继承上级项目' : '暂不设置'}</option>{s.data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></>}{error}
    </Modal>;
  }
  if (dialog.kind === 'dependencies' && task) {
    const root = rootId(s.data.tasks, task.id);
    const candidates = flattenedTasks(s.data.tasks, search).filter(({ task: t }) => rootId(s.data.tasks, t.id) === root);
    const changed = [...deps].sort().join('\0') !== [...initialDeps].sort().join('\0');
    const active = s.data.conversations.filter(c => c.task_id === task.id && isBusy(c));
    const stopping = changed && active.length > 0;
    return <Modal title={`为「${task.title}」设置前置任务`} onClose={onClose} footer={<>{cancel}{submit(stopping ? '停止当前执行并保存依赖' : '保存依赖', () => s.command('dependencies', { task_id: task.id, blocked_by: deps, expected_blocked_by: initialDeps, confirm_stop: stopping }, stopping ? '正在等待停止确认，随后保存依赖' : '依赖已保存；就绪后自动推进'), !changed || stopping && !acknowledged)}</>}>
      <p className="modal-desc">当前任务需要等待以下任务的交付就绪，才能自动执行。只显示「{s.data.tasks.find(t => t.id === root)?.title}」这棵任务树。</p>
      <input aria-label="搜索前置任务" placeholder="搜索任务名称或上下文" value={search} onChange={e => setSearch(e.target.value)}/>
      <div className="dependency-list">{candidates.map(({ task: candidate, depth }) => { const reason = dependencyReason(s.data.tasks, task.id, candidate.id); return <label key={candidate.id} className={`dependency-choice ${reason ? 'disabled' : ''}`} style={{ paddingLeft: 9 + depth * 16 }} title={reason ?? undefined}><input type="checkbox" checked={deps.includes(candidate.id)} disabled={Boolean(reason)} onChange={e => setDeps(current => e.target.checked ? [...current, candidate.id] : current.filter(id => id !== candidate.id))}/><span className="grow">{candidate.title}{reason && <span className="dependency-reason">{reason}</span>}</span><small>{taskLabel(candidate)}</small></label>; })}</div>
      <p className="note">可选择多个。取消或仅标记完成不代表交付就绪；已完成前置任务仍保留关联和来源。</p>
      {stopping && <div className="warning-box"><AlertCircle size={16}/><div><strong>当前有 {active.length} 个会话正在执行或排队</strong><p>先停止本任务的执行，确认后保存依赖。已有修改和聊天保留，不回滚文件。</p><label className="checkline"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/>确认停止当前执行并应用新依赖</label></div></div>}{error}
    </Modal>;
  }
  if (dialog.kind === 'projectTask' && task) return <Modal title="任务默认项目" onClose={onClose} footer={<>{cancel}{submit('保存项目', () => s.command('update_task', { task_id: task.id, patch: { project_id: project || null }, before: { project_id: task.project_id } }, '后续新会话使用新项目；已有会话目录不变'))}</>}><p className="modal-desc">项目由任务继承给新会话。已有 Codex Thread 的工作目录不会被移动。</p><button className={`picker-row ${!project ? 'chosen' : ''}`} onClick={() => setProject('')}>继承上级项目／暂不设置{!project && <Check size={14}/>}</button><ProjectPicker projects={s.data.projects} selected={project} onSelect={setProject}/>{!s.data.projects.some(p=>p.id===task.project_id)&&task.project_id&&<p className="note">原项目已被隐藏或不可用；选择新项目不会移动已有 Thread。</p>}{error}</Modal>;
  if (dialog.kind === 'project') return <Modal title={dialog.id ? '编辑项目' : '添加本地项目'} onClose={onClose} footer={<>{cancel}{submit('保存项目', async () => { const result = await s.command<{ id?: string }>('project', { id: dialog.id, name: text.trim(), path: path.trim() }, '项目已保存'); if (result.id) onNewProject?.(result.id); }, !text.trim() || !path.trim())}</>}><p className="modal-desc">工作目录是你本机的项目目录，不会上传文件。绑定任务后，新会话默认使用它。</p><label htmlFor="project-name">项目名称</label><input id="project-name" value={text} onChange={e => setText(e.target.value)}/><label htmlFor="project-path">工作目录</label><div className="path-input"><input id="project-path" placeholder="/Users/you/Projects/project" value={path} onChange={e => setPath(e.target.value)}/><button className="textbtn outlined" disabled={!s.api.native || busy} onClick={() => void act(async () => { const chosen = await invoke<string | null>('chat_pick_directory'); if (chosen) { setPath(chosen); if (!text) setText(chosen.split('/').filter(Boolean).pop() || '新项目'); } }, false)}>选择目录</button></div>{error}</Modal>;
  if (dialog.kind === 'taskState' && task) return <Modal title="停止执行并变更任务状态？" onClose={onClose} footer={<>{cancel}{submit('确认变更', () => s.command('task_state', {task_id:task.id,state:dialog.state,confirm_stop:true}, '已请求停止当前执行，确认后应用任务状态'))}</>}><p>「{task.title}」存在活动执行。</p><p className="modal-desc">先停止本任务的会话，再切换为{({todo:'待办',in_progress:'进行中',completed:'已完成',cancelled:'已取消'})[dialog.state]}。不会停止子任务，也不会回滚已经产生的文件修改。标记待办会暂停自动推进。</p>{error}</Modal>;
  if ((dialog.kind === 'completeTask' || dialog.kind === 'deleteTask') && task) {
    const removing = dialog.kind === 'deleteTask';
    const childIds = s.data.tasks.filter(t => ancestors(s.data.tasks, t.id).some(p => p.id === task.id)).map(t => t.id);
    const affected = s.data.conversations.filter(c => c.task_id === task.id || removing && childIds.includes(c.task_id));
    const active = affected.filter(isBusy);
    return <Modal title={removing ? '删除任务与子任务？' : '完成这项任务？'} onClose={onClose} footer={<>{cancel}{submit(removing ? '移入已删除' : active.length ? '停止会话并完成任务' : '完成任务', () => s.command(removing ? 'delete_task' : 'task_state', { task_id: task.id, state: 'completed', confirm_stop: Boolean(active.length) }, removing ? '已移入已删除，历史和结果保留' : '任务完成后关联会话进入完成分组'), removing && Boolean(active.length))}</>}><p>「{task.title}」</p><p className="modal-desc">{removing ? `本任务及 ${childIds.length} 个子任务、${affected.length} 个关联会话将从日常列表隐藏。可以从已删除恢复，结果来源不会被物理删除。存在外部依赖时系统会拒绝删除。` : `本任务的 ${affected.length} 个会话将进入非活跃状态，保留消息和结果。不会级联完成 ${childIds.length} 个子任务。缺少交付的下游不会仅凭完成标签自动解除等待。`}</p>{active.length > 0 && <div className="warning-box"><AlertCircle size={16}/><span>{removing ? '请先停止该子树正在运行的会话，再删除。' : `确认后先停止 ${active.length} 个执行；实际停止确认前不会释放依赖。`}</span></div>}{error}</Modal>;
  }
  if (dialog.kind === 'context' && task) return <Modal title="本次任务上下文" wide onClose={onClose} footer={<><button className="textbtn outlined" onClick={onClose}>关闭</button>{dialog.importTo && <button className="textbtn primary" disabled={!context} onClick={() => { onImport(dialog.importTo!); onClose(); }}>带入下一条消息</button>}</>}><p className="modal-desc">当前根任务树、当前任务、各级父任务，以及本次依赖交付。真正执行时再次捕获版本快照，不修改任务原文。</p>{context ? <><details className="context-block" open><summary>当前任务</summary><div className="context-pad"><Markdown text={task.process_tracking || task.title}/></div></details><details className="context-block" open><summary>当前根任务树</summary><pre className="context-tree">{flattenedTasks(s.data.tasks).filter(x => rootId(s.data.tasks, x.task.id) === rootId(s.data.tasks, task.id)).map(({ task: n, depth }) => `${'  '.repeat(depth)}${n.id === task.id ? '→ ' : '· '}${n.title} [${taskLabel(n)}]`).join('\n')}</pre></details><details className="context-block"><summary>来源与完整输入快照</summary><pre>{JSON.stringify(context, null, 2)}</pre></details></> : <p className="note">正在读取上下文…</p>}{error}</Modal>;
  if (dialog.kind === 'models' || dialog.kind === 'permissions') return <Modal title={dialog.kind === 'models' ? '模型与推理强度' : '会话权限'} onClose={onClose} footer={<>{cancel}{submit('保存会话设置', () => c ? s.command('update_conversation', { conversation_id: c.id, revision: c.revision, patch: dialog.kind === 'models' ? { model: model || null, reasoning_effort: effort || null } : { sandbox_mode: sandbox, approval_policy: approval } }, '会话设置已保存') : Promise.reject('请先创建会话'), !c || isBusy(c))}</>}>
    {!c && <p className="modal-desc">先创建或选择一个会话。未设置时使用 Codex 默认模型及按需确认权限。</p>}
    {dialog.kind === 'models' ? <><label htmlFor="model-select">可用模型</label><select id="model-select" value={model} onChange={e => setModel(e.target.value)}><option value="">Codex 默认模型</option>{model && !items.some(x => (x.model || x.id) === model) && <option value={model}>{model}</option>}{items.map(m => <option key={String(m.id)} value={String(m.model || m.id)}>{String(m.displayName || m.model || m.id)}</option>)}</select><label htmlFor="effort-select">推理强度</label><select id="effort-select" value={effort} onChange={e => setEffort(e.target.value)}><option value="">模型默认</option>{['minimal', 'low', 'medium', 'high', 'xhigh'].map(x => <option key={x} value={x}>{x}</option>)}</select><p className="note">模型列表由当前连接返回；选择模型不授予额外权限。</p></> : <><label htmlFor="sandbox-select">文件与网络边界</label><select id="sandbox-select" value={sandbox} onChange={e => setSandbox(e.target.value)}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">完全访问（高风险）</option></select><label htmlFor="approval-select">审批策略</label><select id="approval-select" value={approval} onChange={e => setApproval(e.target.value)}><option value="on-request">需要时由你确认</option><option value="untrusted">不受信任操作需确认</option><option value="never">禁止申请额外权限</option></select>{sandbox === 'danger-full-access' && <p className="warning-box">完全访问可操作项目外文件和网络。保存将显式扩大此会话权限；不会修改全局配置。</p>}</>}{c && isBusy(c) && <p className="note">先停止当前执行，再修改会话配置。</p>}{error}</Modal>;
  if (dialog.kind === 'deleted') return <Modal title="已删除的任务" onClose={onClose} footer={<button className="textbtn outlined" onClick={onClose}>关闭</button>}><p className="modal-desc">删除采用归档方式。恢复后不自动重跑历史任务；从任务详情恢复执行。</p>{items.map(item => <div className="picker-row" key={String(item.id)}><span className="grow">{String(item.title)}</span><button className="textbtn outlined" disabled={busy} onClick={() => void act(async () => { await s.command('restore', { task_id: item.id }, '任务已恢复'); setItems(await s.api.call('deleted')); }, false)}>恢复</button></div>)}{!items.length && <p className="note">暂无已删除任务</p>}{error}</Modal>;
  return null;
}
