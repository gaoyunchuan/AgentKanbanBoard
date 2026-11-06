import {useEffect,useMemo,useState} from 'react';
import {BookOpen,Bot,ChevronRight,Copy,FilePenLine,LoaderCircle,Monitor,Search,Terminal,Wrench} from 'lucide-react';
import {Markdown} from './components';
import {HistoryMessageImage} from './HistoryMessageImages';
import {CompactionStatus} from './CompactionStatus';
import {elapsedTime,toolSummary,transcriptTurns,type TranscriptTurn,type ToolGroup} from './transcript';
import type {TimelineItem,ToolKind} from '../workbench/events';
import type {WorkEvent,WorkRun} from '../workbench/types';
import './transcript.css';
export type TranscriptProps={events:WorkEvent[];runs:WorkRun[];currentRunId?:string|null;onOpenLink?:(href:string)=>void;onOpenRecord?:(id:number)=>void};
const icons={read:BookOpen,search:Search,command:Terminal,edit:FilePenLine,agent:Bot,computer:Monitor,tool:Wrench};
function ToolIcon({kind='tool'}:{kind?:ToolKind}){const Icon=icons[kind];return <Icon size={14} className={`activity-icon activity-${kind}`}/>}
function MessageImage({src,index}:{src:string;index:number}){
 const [failed,setFailed]=useState<string>();
 return failed===src?<span className="message-image-error" role="status">图片 {index+1} 加载失败</span>:<img className="message-image" src={src} alt={`已发送的图片 ${index+1}`} loading="lazy" decoding="async" onError={()=>setFailed(src)}/>;
}
/** 首条消息、中途补充和子 Agent 历史共用气泡，避免其中一条路径再次漏掉附件。 */
function OriginalRecord({item,onOpenRecord}:{item:TimelineItem;onOpenRecord?:TranscriptProps['onOpenRecord']}) {
 if (item.sourceEventId === undefined || !onOpenRecord) return null;
 return <button className="textbtn" onClick={()=>onOpenRecord(item.sourceEventId!)}>分段查看原记录</button>;
}
function UserMessage({item,onOpenLink,onOpenRecord}:{item:TimelineItem;onOpenLink?:TranscriptProps['onOpenLink'];onOpenRecord?:TranscriptProps['onOpenRecord']}){
 if (/^Task ID: [^\n]+\n(?:AKB task input through event \d+|Task context snapshot:)/.test(item.text)) {
   return <details className="run-event context-link" data-history-anchor={item.id}><summary>本轮任务上下文</summary><Markdown text={item.text} onOpenLink={onOpenLink}/><OriginalRecord item={item} onOpenRecord={onOpenRecord}/></details>;
 }
 return <div className="message user" data-history-anchor={item.id}><div className="bubble">{item.userLabel&&<div className="user-message-label">{item.userLabel}</div>}{item.text&&<Markdown text={item.text} onOpenLink={onOpenLink}/>}<OriginalRecord item={item} onOpenRecord={onOpenRecord}/>{Boolean(item.images?.length)&&<div className="message-images">{item.images!.map((src,index)=><MessageImage key={index} src={src} index={index}/>)}</div>}{Boolean(item.imageRefs?.length)&&<div className="message-images">{item.imageRefs!.map((image,index)=><HistoryMessageImage key={image.eventId+":"+image.slot} image={image} index={index}/>)}</div>}{Boolean(item.unavailableImages)&&<span className="message-image-error" role="status">有 {item.unavailableImages} 张图片暂不支持显示</span>}</div></div>;
}

function GeneratedImages({items}:{items:TimelineItem[]}){
 const images=items.flatMap(item=>item.imageRefs??[]);
 if(!images.length)return null;
 return <div className="message-images generated-images" aria-label="生成的图片">{images.map((image,index)=>
  <HistoryMessageImage key={`${image.eventId}:${image.slot}`} image={image} index={index} generated/>
 )}</div>;
}

function ToolRow({item,completed,endedAt,onOpenRecord}:{item:TimelineItem;completed:boolean;endedAt?:string;onOpenRecord?:TranscriptProps['onOpenRecord']}){
 const [open,setOpen]=useState(false),[full,setFull]=useState(false);
 // 子执行结束后，其后代不能沿用仍在运行的主会话计时。
 const childCompleted=completed||['completed','failed','interrupted','cancelled'].includes(item.status||'');
 const childEndedAt=item.endedAt||endedAt;
 return <div className="activity-tool"><button className="activity-line" aria-expanded={open} title={item.title} onClick={()=>setOpen(!open)}><ToolIcon kind={item.toolKind}/><span className="activity-label">{item.label||item.title||'工具调用'}</span>{item.status==='inProgress'&&<LoaderCircle size={12} className="spin"/>}{item.status==='failed'&&<span className="activity-failed">失败</span>}<ChevronRight size={12} className={open?'activity-chevron expanded':'activity-chevron'}/></button>{open&&item.children&&<div className="activity-children">{item.children.map(child=>child.phase==='generated_image'?<GeneratedImages key={child.id} items={[child]}/>:child.role==='tool'?<ToolRow key={child.id} item={child} completed={childCompleted} endedAt={childEndedAt} onOpenRecord={onOpenRecord}/>:child.phase==='compaction'?<CompactionStatus key={child.id} item={child} completed={childCompleted} endedAt={childEndedAt}/>:child.role==='user'?<UserMessage key={child.id} item={child} onOpenRecord={onOpenRecord}/>:<div className="process-message" key={child.id}><Markdown text={child.text}/></div>)}</div>}{open&&!item.children&&<div className="activity-output"><OriginalRecord item={item} onOpenRecord={onOpenRecord}/>{item.toolKind==='command'&&<div className="activity-command">{item.title}</div>}<pre>{item.text?(full?item.text:item.text.slice(0,64000)):'暂无输出'}</pre>{item.text.length>64000&&!full&&<button className="activity-more" onClick={()=>setFull(true)}>显示完整输出</button>}{item.images?.map((src,n)=><img key={n} src={src} alt="工具返回的图片"/>)}</div>}</div>;
}
function ToolCalls({group,completed,endedAt,onOpenRecord}:{group:ToolGroup;completed:boolean;endedAt?:string;onOpenRecord?:TranscriptProps['onOpenRecord']}){
 const [open,setOpen]=useState(false),label=toolSummary(group.items);
 return <div className="activity-group"><button className="activity-line activity-group-summary" aria-expanded={open} onClick={()=>setOpen(!open)}><ToolIcon kind={new Set(group.items.map(i=>i.toolKind)).size>1?'tool':group.items[0].toolKind}/><span>{label}</span>{group.items.some(i=>i.status==='inProgress')&&<LoaderCircle size={12} className="spin"/>}<ChevronRight size={12} className={open?'activity-chevron expanded':'activity-chevron'}/></button>{open&&<div className="activity-children">{group.items.map(item=><ToolRow key={item.id} item={item} completed={completed} endedAt={endedAt} onOpenRecord={onOpenRecord}/>)}</div>}</div>;
}
function Answer({item,onOpenLink,onOpenRecord}:{item:TimelineItem;onOpenLink?:TranscriptProps['onOpenLink'];onOpenRecord?:TranscriptProps['onOpenRecord']}){
 return <div className="transcript-answer" aria-label="最终回答" data-history-anchor={item.id}><Markdown text={item.text} onOpenLink={onOpenLink}/><OriginalRecord item={item} onOpenRecord={onOpenRecord}/><button className="answer-copy" aria-label="复制回答" title="复制回答" onClick={()=>void navigator.clipboard.writeText(item.text).catch(()=>{})}><Copy size={13}/></button></div>;
}
function TurnProcess({turn,onOpenLink,onOpenRecord}:{turn:TranscriptTurn;onOpenLink?:TranscriptProps['onOpenLink'];onOpenRecord?:TranscriptProps['onOpenRecord']}){
 const [open,setOpen]=useState(!turn.completed),[now,setNow]=useState(Date.now());
 useEffect(()=>{setOpen(!turn.completed);setNow(Date.now())},[turn.completed]);
 useEffect(()=>{if(turn.completed)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[turn.completed]);
 return <div className="transcript-turn" data-history-anchor={'turn:'+turn.id}>
  <div className={'work-summary '+(turn.completed?'finished':'')}>
   <button aria-expanded={open} onClick={()=>setOpen(!open)}>
    {turn.completed?'Worked for':'Working for'} {elapsedTime(turn.startedAt,turn.endedAt,now)}
    <ChevronRight size={13} className={open?'activity-chevron expanded':'activity-chevron'}/>
   </button>
  </div>
  {open&&<div className="turn-process" aria-label="执行过程">{turn.process.map(item=>
   'kind'in item?<ToolCalls key={item.id} group={item} completed={turn.completed} endedAt={turn.endedAt} onOpenRecord={onOpenRecord}/>
   :item.phase==='compaction'?<CompactionStatus key={item.id} item={item} completed={turn.completed} endedAt={turn.endedAt}/>
   :item.role==='user'?<UserMessage key={item.id} item={item} onOpenLink={onOpenLink} onOpenRecord={onOpenRecord}/>
   :<div className={'process-message '+(item.phase==='reasoning'?'reasoning-message':'')} key={item.id}><Markdown text={item.text} onOpenLink={onOpenLink}/></div>
  )}</div>}
  {turn.completed&&<div className="turn-divider" role="separator"/>}
 </div>;
}
export function ChatTranscript({events,runs,currentRunId,onOpenLink,onOpenRecord}:TranscriptProps){
 const turns=useMemo(()=>transcriptTurns(events,runs,currentRunId),[events,runs,currentRunId]);
 // 视口中的气泡按消息标识保持挂载。分页改变回合分组时不重建已显示的正文。
 return <div className="chat-transcript">{turns.flatMap(turn=>[
  ...turn.user.map(item=><UserMessage key={'user:'+item.id} item={item} onOpenLink={onOpenLink} onOpenRecord={onOpenRecord}/>),
  ...(turn.process.length ? [<TurnProcess key={'process:'+turn.id} turn={turn} onOpenLink={onOpenLink} onOpenRecord={onOpenRecord}/>] : []),
  ...turn.final.map(item=><Answer key={'answer:'+item.id} item={item} onOpenLink={onOpenLink} onOpenRecord={onOpenRecord}/>),
  ...(turn.generated.length ? [<GeneratedImages key={'images:'+turn.generated[0].id} items={turn.generated}/>] : []),
 ])}</div>;
}
