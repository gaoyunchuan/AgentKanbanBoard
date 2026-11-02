import { useState } from 'react';
import { Shield } from 'lucide-react';
import { useStudio } from './context';
import { type StudioTask, type ExecutionPermissions } from './model';
import { permissionMode, permissionPresets, type PermissionMode } from './permissions';
import { StudioSelect } from './StudioSelect';

export function TaskPermissionField({task}:{task:StudioTask}) {
  const s=useStudio();
  const work=s.data.work_tasks.find(w=>w.task_id===task.id);
  const original=task.execution_permissions??work?.config??permissionPresets['on-request'];
  const [draft,setDraft]=useState<ExecutionPermissions|null>(null);
  const [expected,setExpected]=useState<ExecutionPermissions>(original);
  const [error,setError]=useState('');
  const value=permissionMode(draft??original);
  const choose=(mode:string)=>{
    if(mode==='custom')return;
    // 在首次编辑时固定基线，后台轮询不能给旧草稿借用新权限。
    if(!draft)setExpected({sandbox_mode:original.sandbox_mode,approval_policy:original.approval_policy});
    setDraft({...permissionPresets[mode as Exclude<PermissionMode,'custom'>]});setError('');
  };
  const save=async()=>{
    try {
      await s.command('set_task_permissions',{task_id:task.id,permissions:draft,expected_permissions:expected},'任务权限已保存，后续执行按此设置启动');
      setDraft(null);setError('');
    } catch(e) {setError(String(e));}
  };
  return <div className="field"><label className="field-label" htmlFor="task-execution-permissions"><Shield size={13}/>任务执行权限</label>
    <StudioSelect id="task-execution-permissions" label="任务执行权限" value={value} onValueChange={choose} disabled={s.busy}
      options={[{value:'on-request',label:'按需确认'},{value:'read-only',label:'只读'},{value:'full-access',label:'完全访问'},...(value==='custom'?[{value:'custom',label:'自定义（保留当前设置）',disabled:true}]:[])]}/>
    {draft&&<div className="flex gap"><button className="textbtn outlined" disabled={s.busy} onClick={()=>void save()}>保存任务权限</button><button className="textbtn" disabled={s.busy} onClick={()=>{setDraft(null);setError('')}}>取消修改</button></div>}
    <p className="note">每轮自动执行开始时使用已保存的权限；当前回合与已弹出的确认保持原设置。修改权限不会启动任务。</p>
    {value==='full-access'&&<p className="note">完全访问允许访问项目外文件、网络并运行命令，工具操作不再逐次确认。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </div>;
}
