import type { BackendProject } from "../types";
import type { BackendTodoTask } from "../todo/types";
import type { TaskConfig, WorkTask, WorkEvent, TaskInteraction, WorkRun, WorkbenchData } from "../workbench/types";

export type ResultRecord = { id:string; task_id:string; conversation_id:string; conversation_title:string; source_run_id?:string|null; source_boundary:number; method:"auto"|"manual"|"legacy"; stage:string; markdown:string; evidence:unknown; status:"pending"|"ready"|"failed"|"withdrawn"; usable:boolean; supersedes?:string|null; created_at:string; error?:string|null };
export type StudioTask = BackendTodoTask & { project_id:string|null; effective_project_id:string|null; last_conversation_id?:string|null; metadata_revision:number; blocked_by:string[]; missing_dependencies:string[]; results:ResultRecord[]; pending_change?:string|null };
export type Conversation = { id:string; task_id:string; title:string; mode:"auto"|"manual"; project_id:string|null; config:TaskConfig; thread_id?:string|null; current_run_id?:string|null; runtime_status:string; pinned:boolean; closed:boolean; revision:number; created_at:string; updated_at:string; last_error?:string|null };
export type Workspace = { tasks:StudioTask[]; projects:BackendProject[]; conversations:Conversation[]; work_tasks:WorkTask[]; settings?: { excluded_project_dirs:string[] }; runtime?:WorkbenchData["runtime"] };
export type ConversationDetail = { conversation:Conversation; events:WorkEvent[]; runs:(WorkRun & {kind?:string; context?:unknown})[]; interactions:TaskInteraction[]; work?:WorkTask; results:ResultRecord[] };
export type Group = "pinned"|"active"|"blocked"|"completed";
export const emptyWorkspace:Workspace={tasks:[],projects:[],conversations:[],work_tasks:[]};
export const groups: {id:Group;label:string}[]=[{id:"pinned",label:"置顶"},{id:"active",label:"活跃"},{id:"blocked",label:"阻塞"},{id:"completed",label:"完成"}];
export function conversationGroup(c:Conversation,t:StudioTask):Group {
  if(c.closed||["completed","cancelled"].includes(t.status))return "completed";
  if(t.missing_dependencies.length||["waiting","paused","stopping"].includes(c.runtime_status))return "blocked";
  if(t.pinned||c.pinned)return "pinned";
  return "active";
}
export function runtimeLabel(c?:Conversation) {
  if(!c)return "初始化";
  return ({init:"初始化",queued:"等待执行",running:"进行中",waiting:"等待依赖",needs_input:"待你确认",idle:"本轮结束",failed:"需要处理",paused:"已暂停",stopping:"正在停止"} as Record<string,string>)[c.runtime_status]??c.runtime_status;
}
export function taskLabel(t:StudioTask){return t.pending_change?"正在应用变更":t.status==="completed"?"已完成":t.status==="cancelled"?"已取消":t.missing_dependencies.length?"阻塞":t.status==="in_progress"?"进行中":"待办";}
export function ancestors(tasks:StudioTask[],id:string) {
  const lookup=new Map(tasks.map(t=>[t.id,t]));const result:StudioTask[]=[];const seen=new Set<string>();let t=lookup.get(id);
  while(t?.parent_id&&!seen.has(t.id)){seen.add(t.id);t=lookup.get(t.parent_id);if(t)result.unshift(t);}
  return result;
}
export function rootId(tasks:StudioTask[],id:string){return ancestors(tasks,id)[0]?.id??id;}
export function taskConversations(data:Workspace,taskId:string){return data.conversations.filter(c=>c.task_id===taskId);}
export function preferredConversation(data:Workspace,t:StudioTask){const all=taskConversations(data,t.id);return all.find(c=>c.id===t.last_conversation_id)??all.find(c=>c.mode==="auto")??all[0];}
export function isBusy(c:Conversation){return Boolean(c.current_run_id)||["running","needs_input","stopping"].includes(c.runtime_status);}
export function dependencyReason(tasks:StudioTask[],tid:string,other:string):string|null {
  if(tid===other)return "当前任务不能依赖自身";
  if(!tasks.some(t=>t.id===other))return "任务不存在";
  if(rootId(tasks,tid)!==rootId(tasks,other))return "不属于本任务树";
  const pending=[other],seen=new Set<string>();
  while(pending.length){const n=pending.pop()!;if(n===tid)return "会形成等待循环（包含父任务等待子任务）";if(seen.has(n))continue;seen.add(n);pending.push(...(tasks.find(t=>t.id===n)?.blocked_by??[]),...tasks.filter(t=>t.parent_id===n).map(t=>t.id));}
  return null;
}
export function flattenedTasks(tasks:StudioTask[],search="",projectId?:string) {
  const filter=search.trim().toLocaleLowerCase();const shown=new Set<string>();
  for(const t of tasks)if((!filter||`${t.title}\n${t.process_tracking}`.toLocaleLowerCase().includes(filter))&&(!projectId||t.effective_project_id===projectId)) {shown.add(t.id);ancestors(tasks,t.id).forEach(p=>shown.add(p.id));}
  const result:{task:StudioTask;depth:number}[]=[];const seen=new Set<string>();
  const children=(parent:string|null)=>tasks.filter(t=>(t.parent_id??null)===parent).sort((a,b)=>(parent===null?Number(b.pinned)-Number(a.pinned):0)||a.position-b.position||a.id.localeCompare(b.id));
  const walk=(parent:string|null,depth:number)=>{for(const t of children(parent)){if(seen.has(t.id))continue;seen.add(t.id);if(shown.has(t.id))result.push({task:t,depth});walk(t.id,depth+1);}};
  walk(null,0);return result;
}
export function visibleResults(t:StudioTask){const superseded=new Set(t.results.filter(r=>r.status==="ready").map(r=>r.supersedes).filter(Boolean));return t.results.filter(r=>r.status==="ready"&&!superseded.has(r.id)&&!r.error);}
export const defaultConfig=(workspace=""):TaskConfig=>({agent_id:"codex",delegated_by:"user",workspace,prompt:"",acceptance:"",review_policy:"human",blocked_by:[],approval_policy:"on-request",sandbox_mode:"workspace-write",browser_enabled:false});

export function taskGroup(t:StudioTask,data:Workspace):Group {
  if (["completed","cancelled"].includes(t.status)) return "completed";
  const work=data.work_tasks.find(w=>w.task_id===t.id);
  if (t.missing_dependencies.length || work && ["waiting","paused"].includes(work.status)) return "blocked";
  if (!t.parent_id && t.pinned) return "pinned";
  return "active";
}
export function needsUser(c:Conversation,data:Workspace) {
  return ["needs_input","failed"].includes(c.runtime_status) || c.mode==="auto" && data.work_tasks.some(w=>w.task_id===c.task_id && ["review","attention"].includes(w.status));
}
