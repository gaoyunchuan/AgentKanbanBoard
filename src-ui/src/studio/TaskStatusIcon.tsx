import { CircleDashed, CirclePlay, CircleX, LockKeyhole, CircleCheck } from 'lucide-react';
export function StatusIcon({ status, blocked = false }: { status: string; blocked?: boolean }) {
  // Shape, not only color, identifies the business state everywhere.
  if (status === 'completed') return <CircleCheck size={16} className="green" data-state-icon="completed"/>;
  if (status === 'cancelled') return <CircleX size={16} className="muted" data-state-icon="cancelled"/>;
  if (blocked) return <LockKeyhole size={16} className="orange" data-state-icon="blocked"/>;
  return status === 'in_progress' ? <CirclePlay size={16} className="blue" data-state-icon="in_progress"/> : <CircleDashed size={16} className="muted" data-state-icon="todo"/>;
}
