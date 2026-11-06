/** Isolated browser preview. Never used as fallback when native loading fails. */
import type { StudioApi } from './api';
import {permissionPresets} from './permissions';
import { defaultConfig, type Workspace, type StudioTask, type Conversation, type ConversationDetail, ancestors, rootId, dependencyReason } from './model';
import {conversationCompletionBlocked,conversationDeleteReason,conversationRecoveryReason} from './model';
const now = () => new Date().toISOString();
export function createDemoApi(): StudioApi {
  let seq = 30;
  let delegation: keyof typeof permissionPresets='on-request';
  const task = (id: string, title: string, parent: string | null, blocked: string[] = [], status: StudioTask['status'] = 'todo'): StudioTask => ({ execution_permissions:{...permissionPresets[delegation]}, id, title, parent_id: parent, position: seq++, status, pinned: id === 'diff', process_tracking: parent ? `## 交付要求\n${title}，保留验证证据。` : '## 目标\n发布前对比 Git Revision 与集群上报快照。\n## 已确认约束\n- 控制端不能主动连接集群。\n- 交付可评审 PR，不自动合并或发布。', result_review: '', created_at: now(), updated_at: now(), project_id: parent ? null : 'release', effective_project_id: 'release', metadata_revision: 0, blocked_by: blocked, missing_dependencies: blocked, results: [] });
  const data: Workspace = {
    projects: [{ id: 'release', name: 'release-console', path: '/Users/yc/Projects/release-console', aliases: [], active: true }, { id: 'kanban', name: 'AgentKanbanBoard', path: '/Users/yc/Projects/AgentKanbanBoard', aliases: [], active: true }],
    tasks: [task('diff', '实现部署前 Diff', null, [], 'in_progress'), task('contract', '明确 Diff 接口契约', 'diff', [], 'in_progress'), task('frontend', '实现前端差异展示', 'diff', ['contract']), task('regression', '补齐集成验证', 'diff', ['frontend']), task('review', '整理本机运行说明', null)],
    conversations: [], work_tasks: [], runtime: { connected: false }
  };
  let exclusions:string[]=[];
  const visibleProjects=()=>data.projects.filter(p=>!exclusions.some(root=>p.path===root||p.path.startsWith(root.replace(/\/$/,'')+'/')));
  const deletedConversations=new Map<string,Conversation>();
  const details = new Map<string, ConversationDetail>(), archived: StudioTask[] = [];
  const makeConversation = (taskId: string, mode: 'manual' | 'auto' = 'manual') => {
    const t = data.tasks.find(t => t.id === taskId)!;
    const id = `conversation-${seq++}`;
    const p = data.projects.find(p => p.id === t.effective_project_id);
    const c: Conversation = { activity_at:null,last_output_event_id:0,read_output_event_id:0,read_version:0,manual_unread:false,unread:false, id, task_id: taskId, title: data.conversations.some(c => c.task_id === taskId) ? '交互方案讨论' : t.title, mode, project_id: p?.id || null, config: {...defaultConfig(p?.path),...t.execution_permissions}, runtime_status: mode === 'auto' && t.missing_dependencies.length ? 'waiting' : 'init', pinned: false, closed: false, revision: 0, created_at: now(), updated_at: now() };
    data.conversations.push(c); details.set(id, { conversation: c, events: [], runs: [], interactions: [], results: t.results }); t.last_conversation_id = id; return c;
  };
  const main = makeConversation('diff'); main.last_output_event_id=2;main.read_output_event_id=2; main.runtime_status = 'idle'; main.thread_id = 'demo-thread-main';
  details.get(main.id)!.events = [{ id: 1, task_id: 'diff', run_id: 'demo-run', kind: 'user_message', payload: { text: '完成部署前 Diff，先交付可评审的 PR，不要合并。' }, created_at: now() }, { id: 2, task_id: 'diff', run_id: 'demo-run', kind: 'assistant_message', payload: { text: '我会按照接口契约、前端展示和集成验证推进。\n\n## 已明确的边界\n- 使用集群侧主动上报的快照，不直连集群。\n- 忽略系统生成字段，展示采集时间。\n- 保留验证证据，不自动合并或部署。\n\n这是浏览器演示内容，没有执行真实代码修改。' }, created_at: now() }];
  makeConversation('diff'); makeConversation('contract', 'auto'); makeConversation('frontend', 'auto'); makeConversation('regression', 'auto');
  function refresh() {
    for (const t of data.tasks) { const parent = ancestors(data.tasks, t.id).reverse().find(p => p.project_id); t.effective_project_id = t.project_id || parent?.project_id || null; t.missing_dependencies = t.blocked_by.filter(id => { const upstream = data.tasks.find(x => x.id === id); return !upstream || upstream.status !== 'completed' || !upstream.results.some(r => r.usable && r.status === 'ready'); }); }
    for (const d of details.values()) d.results = data.tasks.find(t => t.id === d.conversation.task_id)?.results || [];
  }
  return { native: false, call: async <T,>(method: string, p: Record<string, unknown> = {}): Promise<T> => {
    const tid = String(p.task_id || ''), cid = String(p.conversation_id || '');
    const t = data.tasks.find(t => t.id === tid), c = data.conversations.find(c => c.id === cid);
    let result: unknown = { saved: true };
    if (method === 'snapshot') { refresh(); result = {...data,projects:visibleProjects(),settings:{excluded_project_dirs:exclusions,delegation_permission:delegation}}; }
    else if (method === 'save_settings') {if(JSON.stringify(p.expected_excluded_project_dirs)!==JSON.stringify(exclusions))throw new Error('设置已改变');exclusions=p.excluded_project_dirs as string[];if(typeof p.delegation_permission==='string')delegation=p.delegation_permission as keyof typeof permissionPresets;result={excluded_project_dirs:exclusions,delegation_permission:delegation};}
    else if (method === 'detail') result = details.get(cid) || { conversation: c, events: [], runs: [], interactions: [], results: [] };
    else if(method==='codex_threads')result={data:[{id:'550e8400-e29b-41d4-a716-446655440010',name:'Codex 中的迁移方案',cwd:'/demo/runtime-api-server',updated_at:1793750400,status:'idle',archived:Boolean(p.archived)}].filter(t=>!p.query||t.name.includes(String(p.query))),nextCursor:null};
    else if(method==='bind_codex_thread'){
      if(!t||['completed','cancelled'].includes(t.status))throw new Error('请先重新打开任务');
      const existing=data.conversations.find(c=>c.thread_id===p.thread_id);
      if(existing&&existing.task_id!==tid)throw new Error('会话已绑定其他任务');
      if(existing)result=existing;
      else{
        const imported=makeConversation(tid);imported.title='Codex 中的迁移方案';imported.thread_id=String(p.thread_id);
        imported.config.workspace='/demo/runtime-api-server';imported.project_id=null;imported.codex_binding=false;imported.runtime_status='idle';result=imported;
      }
    }
    else if(method==='codex_history')result={data:[{id:'original-question',turn_id:'original-turn',kind:'userMessage',text:'Codex 中已有的原始问题'},{id:'original-answer',turn_id:'original-turn',kind:'agentMessage',text:'继续沿用原会话讨论的迁移方案。'}],nextCursor:null};
    else if(method==='open_recovery_thread'||method==='recover_connection'){
      if(!c)throw new Error('会话不存在');
      if(c.revision!==p.revision||c.thread_id!==p.thread_id)throw new Error('会话已变化');
      const reason=conversationRecoveryReason(c,data);if(reason)throw new Error(reason);
      if(method==='recover_connection'){c.last_error=null;c.runtime_status='idle';if(c.codex_binding===false)c.codex_binding=true;}
      result={recovered:method==='recover_connection',demo:true,thread_id:c.thread_id};
    }
    else if (method === 'context') result = { task: t, task_tree: data.tasks.filter(x => rootId(data.tasks, x.id) === rootId(data.tasks, tid)).map(x => ({ id: x.id, title: x.title, parent_id: x.parent_id })), ancestors: ancestors(data.tasks, tid), dependencies: t?.blocked_by.map(id => ({ id, results: data.tasks.find(t => t.id === id)?.results })) };
    else if (method === 'create_task') { const id = `task-${seq++}`; const created = task(id, String(p.title), p.parent_id ? String(p.parent_id) : null); created.project_id = p.project_id ? String(p.project_id) : null; if(p.after_id){const after=data.tasks.find(t=>t.id===p.after_id)!;for(const row of data.tasks)if(row.parent_id===after.parent_id&&row.position>after.position)row.position++;created.position=after.position+1;}data.tasks.push(created); refresh(); result = { task_id: id }; }
    else if (method === 'create_conversation') {const created=makeConversation(tid);if(p.project_id){const project=visibleProjects().find(x=>x.id===p.project_id);if(!project)throw new Error('项目不可用');created.project_id=project.id;created.config.workspace=project.path;}result=created;}
    else if (method === 'visit' && c) data.tasks.find(t => t.id === c.task_id)!.last_conversation_id = cid;
    else if(method==='mark_unread'&&c){c.manual_unread=true;c.unread=true;c.read_version=(c.read_version??0)+1;}
    else if(method==='mark_read'&&c){
      if(Number(p.boundary)<0||Number(p.boundary)>(c.last_output_event_id??0))throw new Error('阅读边界无效');
      if(p.read_version===(c.read_version??0)){c.read_output_event_id=Math.max(c.read_output_event_id??0,Number(p.boundary));c.manual_unread=false;c.unread=(c.last_output_event_id??0)>c.read_output_event_id;}
    }
    else if (method === 'set_start_time' && t) {if((t.scheduled_start_at??null)!==p.expected_start_at)throw new Error('开始时间已被修改');t.scheduled_start_at=p.scheduled_start_at as string|null;t.updated_at=now();}
    else if (method === 'set_task_permissions' && t) {if(JSON.stringify(t.execution_permissions)!==JSON.stringify(p.expected_permissions))throw new Error('任务权限已被修改，请刷新后重试');t.execution_permissions=structuredClone(p.permissions) as StudioTask['execution_permissions'];for(const c of data.conversations.filter(c=>c.task_id===tid&&c.mode==='auto')){Object.assign(c.config,t.execution_permissions);c.revision++;}for(const w of data.work_tasks.filter(w=>w.task_id===tid)){Object.assign(w.config,t.execution_permissions);w.revision++;}}
    else if (method === 'update_task' && t) { const patch = p.patch as Record<string, unknown>, before = p.before as Record<string, unknown>; if(patch.pinned&&t.parent_id)throw new Error('只有根任务支持置顶'); for (const key of Object.keys(patch)) { if ((t as unknown as Record<string, unknown>)[key] !== before[key]) throw new Error('任务已修改，请刷新重试'); (t as unknown as Record<string, unknown>)[key] = patch[key]; } refresh(); }
    else if (method === 'move_task' && t) {if((p.expected_parent_id??null)!==(t.parent_id??null))throw new Error('层级已改变');const parent=p.parent_id?String(p.parent_id):null;if(t.id===parent||parent&&ancestors(data.tasks,parent).some(x=>x.id===t.id))throw new Error('不能移动到自己的子树');if(parent===t.parent_id)return {saved:true} as T;const was=t.pinned;t.parent_id=parent;t.position=Math.max(-1,...data.tasks.filter(x=>(x.parent_id??null)===parent).map(x=>x.position))+1;if(parent){t.pinned=false;if(was)data.tasks.find(x=>x.id===rootId(data.tasks,parent))!.pinned=true;}refresh();}
    else if (method === 'update_conversation' && c) { if (p.revision !== c.revision) throw new Error('会话版本已改变'); const patch = p.patch as Record<string, unknown>; for (const key of ['title', 'pinned'] as const) if (key in patch) (c as unknown as Record<string, unknown>)[key] = patch[key]; if (patch.project_id) { if (c.thread_id) throw new Error('真实会话项目已固定'); const project = data.projects.find(x => x.id === patch.project_id)!; c.project_id = project.id; c.config.workspace = project.path; } for (const key of ['model', 'reasoning_effort', 'browser_enabled', 'sandbox_mode', 'approval_policy']) if (key in patch) (c.config as unknown as Record<string, unknown>)[key] = patch[key]; if(c.mode==='auto'&&('sandbox_mode' in patch||'approval_policy' in patch)){data.tasks.find(t=>t.id===c.task_id)!.execution_permissions={sandbox_mode:c.config.sandbox_mode,approval_policy:c.config.approval_policy};}c.revision++; }
    else if (method === 'dependencies' && t) { const blockers = p.blocked_by as string[]; for (const b of blockers) { const reason = dependencyReason(data.tasks, tid, b); if (reason) throw new Error(reason); } if (JSON.stringify(p.expected_blocked_by) !== JSON.stringify(t.blocked_by)) throw new Error('依赖已改变'); t.blocked_by = blockers; refresh(); for (const c of data.conversations.filter(c => c.task_id === tid)) if (t.missing_dependencies.length) c.runtime_status = 'waiting'; }
    else if (method === 'send' && c) { if(c.codex_binding===false)throw new Error('请先完成会话交接'); const task = data.tasks.find(t => t.id === c.task_id)!; if (task.missing_dependencies.length) throw new Error('前置交付尚未就绪'); c.thread_id ||= `demo-thread-${seq++}`; c.runtime_status = 'idle'; const d = details.get(cid)!, runId = `demo-run-${seq++}`; d.events.push({ id: seq++, task_id: task.id, run_id: runId, kind: 'user_message', payload: { text: p.text, attachments: p.attachments || [] }, created_at: now() }, { id: seq++, task_id: task.id, run_id: runId, kind: 'assistant_message', payload: { text: '消息已加入本地交互演示。\n\n本页面不会调用真实 Codex。实际模型执行、权限与结果整理请在桌面应用验收。' }, created_at: now() }); c.activity_at=now();c.last_output_event_id=d.events[d.events.length-1].id;c.unread=true; }
    else if (method === 'delegate' && t) { let conversation = data.conversations.find(c => c.task_id === t.id && c.mode === 'auto'); if (!conversation) conversation = makeConversation(t.id, 'auto'); conversation.runtime_status = t.missing_dependencies.length ? 'waiting' : 'init'; }
    else if (method === 'task_state' && t) { t.status = p.state === 'reopen' ? 'todo' : p.state as StudioTask['status']; for (const c of data.conversations.filter(c => c.task_id === tid)) { c.closed = ['completed','cancelled'].includes(String(p.state)); c.current_run_id = null; c.runtime_status = 'idle'; } if (t.status === 'completed') t.results.filter(r => r.status === 'ready').forEach(r => { r.usable = true; }); refresh(); }
    else if (method === 'extract' && c) { const task = data.tasks.find(t => t.id === c.task_id)!; const boundary = details.get(cid)!.events[details.get(cid)!.events.length - 1]?.id || 0; if (!boundary) throw new Error('尚无可提取内容'); if (task.results.some(r => r.conversation_id === cid && r.source_boundary === boundary && r.status === 'ready')) throw new Error('这段会话已提取'); task.results.push({ id: `result-${seq++}`, task_id: task.id, conversation_id: cid, conversation_title: c.title, source_run_id: 'demo-run', source_boundary: boundary, method: 'manual', stage: 'summary', markdown: '## 演示结果\n已讨论实施边界。\n\n**未执行真实代码、测试或模型总结。**', evidence: [], status: 'ready', usable: false, created_at: now() }); }
    else if (method === 'withdraw_result') { for (const t of data.tasks) for (const r of t.results) if (r.id === p.result_id) { r.status = 'withdrawn'; r.usable = false; } }
    else if(method==='delete_conversation'){
      if(!c)throw new Error('会话不存在');const reason=conversationDeleteReason(c,data);if(reason)throw new Error(reason);
      if(c.revision!==p.revision)throw new Error('会话已变化，请刷新后重新确认删除');
      c.revision++;deletedConversations.set(cid,c);data.conversations=data.conversations.filter(x=>x.id!==cid);
    }
    else if(method==='deleted_conversations')result=[...deletedConversations.values()].map(c=>({...c,task_title:data.tasks.find(t=>t.id===c.task_id)?.title||archived.find(t=>t.id===c.task_id)?.title,task_deleted:!data.tasks.some(t=>t.id===c.task_id)}));
    else if(method==='restore_conversation'){
      const found=deletedConversations.get(cid);if(!found)throw new Error('会话不存在或已恢复');
      if(!data.tasks.some(t=>t.id===found.task_id))throw new Error('请先恢复任务');if(found.revision!==p.revision)throw new Error('会话已变化');
      found.revision++;data.conversations.push(found);deletedConversations.delete(cid);
    }
    else if (method === 'complete_conversation') {
      if(!c||p.revision!==c.revision)throw new Error('会话已变化，请刷新后再完成');
      if(conversationCompletionBlocked(c,data))throw new Error('请等待会话执行结束并释放资源，再完成会话');
      if(!c.closed){c.closed=true;c.revision++;}
    }
    else if (method === 'close_conversation' && c) c.closed = true;
    else if (method === 'reopen_conversation' && c) c.closed = false;
    else if (method === 'stop' && c) { c.runtime_status = 'paused'; c.current_run_id = null; }
    else if (method === 'project') { const existing = data.projects.find(x => x.id === p.id); const project = { id: existing?.id || `project-${seq++}`, name: String(p.name), path: String(p.path), aliases: [], active: true }; if (existing) Object.assign(existing, project); else data.projects.push(project); result = { id: project.id }; }
    else if (method === 'delete_task' && t) { const ids = [tid, ...data.tasks.filter(x => ancestors(data.tasks, x.id).some(a => a.id === tid)).map(x => x.id)]; if (data.tasks.some(x => !ids.includes(x.id) && x.blocked_by.some(id => ids.includes(id)))) throw new Error('其他任务仍依赖该子树'); archived.push(...data.tasks.filter(t => ids.includes(t.id))); data.tasks = data.tasks.filter(t => !ids.includes(t.id)); data.conversations = data.conversations.filter(c => !ids.includes(c.task_id)); }
    else if (method === 'deleted') result = archived;
    else if (method === 'restore') { const found = archived.find(t => t.id === tid); if (found) { data.tasks.push(found); archived.splice(archived.indexOf(found), 1); } }
    else if (!['retry_extract', 'respond', 'work_action'].includes(method)) throw new Error(`演示未实现 ${method}`);
    return structuredClone(result) as T;
  } };
}
