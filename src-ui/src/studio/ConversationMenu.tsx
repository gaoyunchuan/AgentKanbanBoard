import { Trash2 } from 'lucide-react';
import { useStudio } from './context';
import { conversationDeleteReason, conversationRecoveryReason, type Conversation } from './model';

export function ConversationMenu({conversation:c,onClose}:{conversation:Conversation;onClose:()=>void}){
  const s=useStudio(),reason=conversationDeleteReason(c,s.data);
  const act=(fn:()=>void)=>{onClose();fn()};
  return <>
    <button className="popitem" onClick={()=>act(()=>s.locateTask(c.task_id))}>在任务树中定位</button>
    <button className="popitem" onClick={()=>act(()=>{void s.newConversation(c.task_id)})}>新建同任务会话</button>
    <button className="popitem" onClick={()=>act(()=>{void s.command('update_conversation',{conversation_id:c.id,revision:c.revision,patch:{pinned:!c.pinned}}).catch(()=>{})})}>{c.pinned?'取消单独置顶':'单独置顶会话'}</button>
    <button className="popitem" onClick={()=>act(()=>s.openDialog({kind:'renameConversation',conversation:c.id}))}>重命名会话</button>
    <button className="popitem" title={conversationRecoveryReason(c,s.data)} disabled={Boolean(conversationRecoveryReason(c,s.data))||s.busy} onClick={()=>act(()=>s.openDialog({kind:'recoverConnection',conversation:c.id}))}>恢复会话连接</button>
    <button className="popitem" onClick={()=>act(()=>{void s.command(c.closed?'reopen_conversation':'close_conversation',{conversation_id:c.id}).catch(()=>{})})}>{c.closed?'恢复会话':'停止并收起为完成'}</button>
    <div className="popline"/>
    <button className="popitem danger" disabled={Boolean(reason)||s.busy} onClick={()=>act(()=>s.openDialog({kind:'deleteConversation',conversation:c.id}))}><Trash2 size={14}/>删除会话</button>
    {reason&&<p className="conversation-delete-reason">{reason}</p>}
  </>;
}
