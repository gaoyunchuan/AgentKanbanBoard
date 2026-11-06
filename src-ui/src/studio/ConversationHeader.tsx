import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Ellipsis, FileText, ListTree, MessageSquare, Plus, SlidersHorizontal, X } from 'lucide-react';
import { HoverInfo } from './components';
import { useStudio } from './context';
import { ConversationMenu } from './ConversationMenu';
import { ConversationIndicator, conversationExecutionIndicator } from './ConversationIndicator';
import { ancestors, conversationCompletionBlocked, isBusy, orderedTaskConversations, runtimeLabel, type Conversation } from './model';

function conversationIndicator(c: Conversation) {
  return conversationExecutionIndicator(c) ?? (c.unread ? '有未读消息' : undefined);
}

function ConversationTabs({active, selected}: {active: Conversation[]; selected?: string}) {
  const s = useStudio();
  const list = useRef<HTMLDivElement>(null);
  const selectedTab = useRef<HTMLButtonElement>(null);
  const hasSelectedTab = active.some(c => c.id === selected);
  useEffect(() => {
    const strip = list.current, tab = selectedTab.current?.parentElement;
    if (!strip || !tab) return;
    const box = strip.getBoundingClientRect(), target = tab.getBoundingClientRect();
    // 只滚动标签条，切换会话时不移动正文或原生窗口。
    if (target.left < box.left) strip.scrollLeft += target.left - box.left;
    else if (target.right > box.right) strip.scrollLeft += target.right - box.right;
  }, [selected, hasSelectedTab]);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowLeft' ? (index + active.length - 1) % active.length
      : event.key === 'ArrowRight' ? (index + 1) % active.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? active.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    s.openConversation(active[next].id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  if (!active.length) return null;
  return <div className="dock-tabs conversation-tabs" ref={list} role="tablist" aria-label="本任务会话标签">
    {active.map((c, index) => {
      const status = conversationIndicator(c);
      const blocked = conversationCompletionBlocked(c, s.data);
      const current = c.id === selected;
      return <div className={`dock-tab ${current ? 'active' : ''}`} key={c.id}>
        <button role="tab" ref={current ? selectedTab : undefined} aria-selected={current}
          tabIndex={current || !hasSelectedTab && index === 0 ? 0 : -1}
          aria-description={status} title={`${c.title} · ${status ?? runtimeLabel(c)}`}
          onClick={() => s.openConversation(c.id)} onKeyDown={event => navigate(event, index)}>
          <ConversationIndicator status={status}/><span>{c.title}</span>
        </button>
        <button className="tab-close" aria-label={`完成会话：${c.title}`}
          title={blocked ? '请等待会话执行结束并释放资源' : '完成会话，保留历史'}
          disabled={blocked || s.busy} onClick={() => void s.completeConversation(c)}>
          <X size={12}/>
        </button>
      </div>;
    })}
  </div>;
}

function ConversationPicker({all, canCreate}: {all: Conversation[]; canCreate: boolean}) {
  const s = useStudio();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setMenu(undefined); };
  useEffect(close, [s.task?.id, s.conversation?.id]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent | globalThis.KeyboardEvent) => {
      if ('key' in event) {
        if (event.key !== 'Escape') return;
        trigger.current?.focus();
      } else if (root.current?.contains(event.target as Node)) return;
      close();
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, [open]);

  return <div className="menu-anchor conversation-picker" ref={root}>
    <button className="iconbtn" ref={trigger} aria-label="切换本任务会话" title="查看本任务全部会话"
      aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
      <ChevronDown size={14}/>
    </button>
    {open && <div className="inline-menu align-right">
      <div className="pop-label">本任务的 {all.length} 个会话</div>
      <div className="conversation-picker-list" role="group" aria-label="本任务全部会话">
        {all.map((c, index) => <div key={c.id}>
          {c.closed && index > 0 && !all[index - 1].closed && <div className="popline"/>}
          <div className="conversation-switch-row">
            <button className="popitem" title={c.title} aria-label={c.closed ? `${c.title} 已完成` : undefined}
              aria-description={conversationIndicator(c)}
              onClick={() => { s.openConversation(c.id); close(); }}>
              <MessageSquare size={13}/><span className="truncate grow">{c.title}</span>
              <ConversationIndicator status={conversationIndicator(c)}/>
              {c.closed && <span className="conversation-history-label">已完成</span>}
              {c.id === s.conversation?.id && <Check size={12}/>}
            </button>
            <button className="iconbtn" aria-label={`${c.title} 会话菜单`} aria-expanded={menu === c.id}
              onClick={() => setMenu(menu === c.id ? undefined : c.id)}><Ellipsis size={15}/></button>
          </div>
          {menu === c.id && <div className="conversation-row-actions"><ConversationMenu conversation={c} onClose={close}/></div>}
        </div>)}
      </div>
      <button className="popitem" disabled={!canCreate} onClick={() => { void s.newConversation(s.task!.id); close(); }}>
        <Plus size={14}/>新建会话
      </button>
    </div>}
  </div>;
}

export function ConversationHeader() {
  const s = useStudio(), t = s.task, c = s.conversation;
  if (!t) return <div className="head-title"><h1>新会话</h1></div>;
  const all = orderedTaskConversations(s.data, t.id);
  const active = all.filter(c => !c.closed);
  const canCreate = !s.busy && !['completed', 'cancelled'].includes(t.status);
  const canExtract = c?.thread_id && c.codex_binding !== false && !isBusy(c) && !s.busy
    && !t.results.some(r => r.conversation_id === c.id && r.status === 'pending');
  return <>
    <div className={`head-title task-conversation-title ${active.length ? 'with-conversation-tabs' : ''}`}>
      <button className="iconbtn header-locate" aria-label="在任务树中定位"
        title={[...ancestors(s.data.tasks, t.id).map(x => x.title), t.title].join(' / ')}
        onClick={() => s.locateTask(t.id)}><ListTree size={15}/></button>
      <HoverInfo data={s.data} task={t} conversation onTask={s.openTask} onOpen={() => s.locateTask(t.id)}>
        <h1 title={t.title}>{t.title}</h1>
      </HoverInfo>
    </div>
    <ConversationTabs active={active} selected={c?.id}/>
    {all.length > 0 && <ConversationPicker all={all} canCreate={canCreate}/>}
    <div className="header-actions">
      <button className="iconbtn" aria-label="新建本任务会话" title="新建本任务会话（不是子任务）"
        disabled={!canCreate} onClick={() => void s.newConversation(t.id)}><Plus size={16}/></button>
      <button className="textbtn" title="提取当前会话结果并追加到任务" disabled={!canExtract}
        onClick={() => { if (c) void s.command('extract', {conversation_id: c.id}, '正在整理结果，原业务操作不会重跑').then(() => s.setPanel('results')).catch(() => {}); }}>
        <FileText size={15}/><span className="extract-label">提取结果</span>
      </button>
      <button className={`iconbtn ${s.inspectorOpen ? 'selected' : ''}`} aria-label="会话属性" title="会话属性"
        aria-expanded={Boolean(s.inspectorOpen)} aria-controls="center-properties"
        onClick={() => s.inspectorOpen ? s.setInspectorOpen?.(false) : s.setPanel('properties')}><SlidersHorizontal size={16}/></button>
    </div>
  </>;
}
