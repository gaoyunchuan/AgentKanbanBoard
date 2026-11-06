import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { Conversation } from './model';

export function conversationExecutionIndicator(conversation: Conversation) {
  if (['running', 'stopping'].includes(conversation.runtime_status)) return '执行中';
  if (conversation.runtime_status === 'needs_input') return '待你确认';
  return undefined;
}

export function ConversationIndicator({status}: {status?: string}) {
  if (status === '执行中') return <LoaderCircle className="spin conversation-spinner" size={13} aria-hidden="true"/>;
  if (status === '待你确认') return <CircleAlert className="conversation-awaiting-input" size={13} aria-hidden="true"/>;
  if (status === '有未读消息') return <span className="unread-dot" title="未读消息" aria-hidden="true"/>;
  return null;
}
