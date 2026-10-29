import { useState } from 'react';
import type { WorkTask } from '../workbench/types';
import { useStudio } from './context';

export function TaskExecutionControls({work}: {work: WorkTask}) {
  const s = useStudio();
  const [feedback, setFeedback] = useState('');
  const stopping = work.execution_status === 'stopping';
  const resumable = ['paused','attention'].includes(work.status) || work.status === 'waiting' && work.wait_reason === 'environment';
  const reworkable = ['review','completed','cancelled','attention'].includes(work.status);
  const act = (action: 'pause'|'resume'|'retry'|'rework') => s.command('work_action', {
    task_id:work.task_id, action, expected_revision:work.revision,
    ...(action === 'rework' ? {feedback:feedback.trim()} : {}),
  }, action === 'rework' ? '已启动返工，旧交付与反馈保留' : action === 'pause' ? '已暂停自动执行，等待停止确认' : '已恢复自动执行').then(()=>setFeedback('')).catch(()=>{});
  return <div className="field">
    <div className="field-label">自动执行控制</div>
    {['queued','running','waiting'].includes(work.status) && <button className="textbtn outlined" disabled={s.busy||stopping} onClick={()=>void act('pause')}>暂停自动执行</button>}
    {resumable && <button className="textbtn outlined" disabled={s.busy||stopping} onClick={()=>void act(work.status === 'attention' ? 'retry' : 'resume')}>恢复自动执行</button>}
    {reworkable && <>
      <label>返工要求<textarea aria-label="属性返工反馈" value={feedback} onChange={e=>setFeedback(e.target.value)}/></label>
      <p className="note">旧结果保留为历史，新一轮重新交付和验收；不会自动回滚文件或重开下游。</p>
      <button className="textbtn outlined" disabled={!feedback.trim()||s.busy||stopping||Boolean(work.current_run_id)} onClick={()=>void act('rework')}>提交反馈并返工</button>
    </>}
  </div>;
}
