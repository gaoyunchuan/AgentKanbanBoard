import { X } from 'lucide-react';
import { useStudio } from './context';
import { Inspector } from './Inspector';

export function TaskDetails({conversationVisible}:{conversationVisible:boolean}) {
  const s=useStudio();
  // 属性与工具是独立区域；只隐藏同一个 Inspector，保留上下文草稿及已选页签。
  return <aside id="center-properties" className={`task-details ${conversationVisible?'conversation-properties':'tree-properties'}`} aria-label={conversationVisible?'会话属性面板':'任务属性区域'} hidden={conversationVisible&&!s.inspectorOpen}>
    {conversationVisible&&<button className="iconbtn properties-close" aria-label="收起会话属性" onClick={()=>s.setInspectorOpen?.(false)}><X size={15}/></button>}
    <Inspector tab={s.inspectorTab||'content'} onTab={s.setPanel}/>
  </aside>;
}
