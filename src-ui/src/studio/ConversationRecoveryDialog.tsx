import {useState} from 'react';
import {Modal} from './components';
import {useStudio} from './context';
import {conversationRecoveryReason} from './model';

export function ConversationRecoveryDialog({conversationId,onClose}:{conversationId:string;onClose:()=>void}){
 const s=useStudio();
 // 冻结目标，切换会话和后台轮询不能把确认应用到另一个 Thread 或版本。
 const [target]=useState(()=>s.data.conversations.find(c=>c.id===conversationId));
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const current=s.data.conversations.find(c=>c.id===target?.id);
 const reason=!current?'会话已删除或暂不可见':current.revision!==target?.revision||current.thread_id!==target?.thread_id?'会话已变化，请关闭后重新打开恢复入口':conversationRecoveryReason(current,s.data);
 const run=async(method:string)=>{
  if(!target||reason||busy)return;
  setBusy(true);setError('');
  try{
   await s.command(method,{conversation_id:target.id,thread_id:target.thread_id,revision:target.revision},method==='recover_connection'?'原会话连接已恢复；请核对进展后自行发送消息':undefined);
   if(method==='recover_connection')onClose();
  }catch(e){setError(String(e))}finally{setBusy(false)}
 };
 return <Modal title="恢复会话连接" onClose={()=>{if(!busy)onClose()}} footer={<>
  <button className="textbtn outlined" disabled={busy} onClick={onClose}>取消</button>
  <button className="textbtn primary" disabled={busy||!confirmed||Boolean(reason)||s.busy} onClick={()=>void run('recover_connection')}>{busy?'处理中…':'已归档，恢复连接'}</button>
 </>}>
  <p>{target?.title||'已不可见的会话'}</p>
  <ol className="modal-desc"><li>打开 Codex 中的原会话，确认执行已结束。</li><li>在 Codex 中手动归档这一条会话，再回到这里恢复连接。</li></ol>
  <button className="textbtn outlined" disabled={busy||Boolean(reason)||s.busy} onClick={()=>void run('open_recovery_thread')}>打开 Codex 中的原会话</button>
  <p className="modal-desc">恢复原会话和连接，不自动发送消息，失败消息不会重发。{typeof target?.codex_binding==='boolean'?'Codex 原历史可在会话中刷新查看；接续前请核对进展。':'Codex 中新增的消息暂不自动导入 Kanban；接续前请先核对进展。'}</p>
  <label className="checkline"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>我已核对执行结束，并在 Codex 中归档了这条会话</label>
  {reason&&<p className="warning-box">{reason}</p>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </Modal>;
}
