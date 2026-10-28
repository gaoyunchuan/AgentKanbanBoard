import { useState } from 'react';
import { Clock } from 'lucide-react';
import { useStudio } from './context';
import { isBusy, type StudioTask } from './model';
export function toLocalInput(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function toUtcSeconds(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || toLocalInput(date.toISOString()) !== value) throw new Error('开始时间无效，请重新选择');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
export function ScheduledStartField({task}:{task: StudioTask}) {
  const s=useStudio();
  const [draft,setDraft]=useState<string|null>(null), [error,setError]=useState('');
  const original=task.scheduled_start_at??null;
  const [expected,setExpected]=useState(original);
  const running=s.data.conversations.some(c=>c.task_id===task.id&&isBusy(c))||Boolean(s.data.work_tasks.find(w=>w.task_id===task.id)?.current_run_id)||Boolean(task.pending_change);
  const delegated=s.data.work_tasks.some(w=>w.task_id===task.id);
  const value=draft??toLocalInput(original);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const save=async()=>{try{setError('');await s.command('set_start_time',{task_id:task.id,scheduled_start_at:toUtcSeconds(value),expected_start_at:expected},'开始时间已保存；仍须满足委托、依赖和执行条件');setDraft(null)}catch(e){setError(String(e))}};
  return <div className="field schedule-field"><label className="field-label" htmlFor="scheduled-start"><Clock size={13}/>开始时间 · {zone}</label><input id="scheduled-start" type="datetime-local" step="60" value={value} disabled={running||s.busy} onChange={e=>{if(draft===null)setExpected(original);setDraft(e.target.value)}}/>
    <div className="flex gap"><button className="textbtn outlined" disabled={running||s.busy||draft===null} onClick={()=>void save()}>保存开始时间</button>{value&&<button className="textbtn" disabled={running||s.busy} onClick={()=>{setExpected(original);setDraft('')}}>清除</button>}{draft!==null&&<button className="textbtn" onClick={()=>{setDraft(null);setError('')}}>取消修改</button>}</div>
    <p className="note">{running?'当前有执行，先暂停并等待停止确认后再调整时间。':!delegated?'只保存时间不会启动；委托给 Agent 后，时间、依赖等条件同时满足才执行。':value?'这是最早允许自动执行的时间，不是定时强制运行。':'未设置时沿用现有自动执行规则。'}应用关闭或电脑休眠时不执行，恢复后重新检查条件。人工附加会话不受此时间限制。</p>{error&&<p className="form-error" role="alert">{error}</p>}</div>;
}
