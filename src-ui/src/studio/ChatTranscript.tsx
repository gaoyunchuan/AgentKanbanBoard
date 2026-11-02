import {useEffect,useMemo,useState} from 'react';
import {BookOpen,Bot,ChevronRight,Copy,FilePenLine,LoaderCircle,Monitor,Search,Terminal,Wrench} from 'lucide-react';
import {Markdown} from './components';
import {elapsedTime,toolSummary,transcriptTurns,type TranscriptTurn,type ToolGroup} from './transcript';
import type {TimelineItem,ToolKind} from '../workbench/events';
import type {WorkEvent,WorkRun} from '../workbench/types';
import './transcript.css';
export type TranscriptProps={events:WorkEvent[];runs:WorkRun[];currentRunId?:string|null;onOpenLink?:(href:string)=>void};
const icons={read:BookOpen,search:Search,command:Terminal,edit:FilePenLine,agent:Bot,computer:Monitor,tool:Wrench};
function ToolIcon({kind='tool'}:{kind?:ToolKind}){const Icon=icons[kind];return <Icon size={14} className={`activity-icon activity-${kind}`}/>}
function ToolRow({item}:{item:TimelineItem}){
 const [open,setOpen]=useState(false),[full,setFull]=useState(false);
 return <div className="activity-tool"><button className="activity-line" aria-expanded={open} title={item.title} onClick={()=>setOpen(!open)}><ToolIcon kind={item.toolKind}/><span className="activity-label">{item.label||item.title||'工具调用'}</span>{item.status==='inProgress'&&<LoaderCircle size={12} className="spin"/>}{item.status==='failed'&&<span className="activity-failed">失败</span>}<ChevronRight size={12} className={open?'activity-chevron expanded':'activity-chevron'}/></button>{open&&item.children&&<div className="activity-children">{item.children.map(child=>child.role==='tool'?<ToolRow key={child.id} item={child}/>:<div className="process-message" key={child.id}><Markdown text={child.text}/></div>)}</div>}{open&&!item.children&&<div className="activity-output">{item.toolKind==='command'&&<div className="activity-command">{item.title}</div>}<pre>{item.text?(full?item.text:item.text.slice(0,64000)):'暂无输出'}</pre>{item.text.length>64000&&!full&&<button className="activity-more" onClick={()=>setFull(true)}>显示完整输出</button>}{item.images?.map((src,n)=><img key={n} src={src} alt="工具返回的图片"/>)}</div>}</div>;
}
function ToolCalls({group}:{group:ToolGroup}){
 const [open,setOpen]=useState(false),label=toolSummary(group.items);
 return <div className="activity-group"><button className="activity-line activity-group-summary" aria-expanded={open} onClick={()=>setOpen(!open)}><ToolIcon kind={new Set(group.items.map(i=>i.toolKind)).size>1?'tool':group.items[0].toolKind}/><span>{label}</span>{group.items.some(i=>i.status==='inProgress')&&<LoaderCircle size={12} className="spin"/>}<ChevronRight size={12} className={open?'activity-chevron expanded':'activity-chevron'}/></button>{open&&<div className="activity-children">{group.items.map(item=><ToolRow key={item.id} item={item}/>)}</div>}</div>;
}
function Answer({item,onOpenLink}:{item:TimelineItem;onOpenLink?:TranscriptProps['onOpenLink']}){
 return <div className="transcript-answer"><Markdown text={item.text} onOpenLink={onOpenLink}/><button className="answer-copy" aria-label="复制回答" title="复制回答" onClick={()=>void navigator.clipboard.writeText(item.text).catch(()=>{})}><Copy size={13}/></button></div>;
}
function Turn({turn,onOpenLink}:{turn:TranscriptTurn;onOpenLink?:TranscriptProps['onOpenLink']}){
 const [open,setOpen]=useState(!turn.completed),[now,setNow]=useState(Date.now());
 useEffect(()=>{setOpen(!turn.completed);setNow(Date.now())},[turn.completed]);
 useEffect(()=>{if(turn.completed)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[turn.completed]);
 return <div className="transcript-turn">{turn.user.map(item=><div className="message user" key={item.id}><div className="bubble"><Markdown text={item.text} onOpenLink={onOpenLink}/></div></div>)}{turn.process.length>0&&<><div className={`work-summary ${turn.completed?'finished':''}`}><button aria-expanded={open} onClick={()=>setOpen(!open)}>{turn.completed?'Worked for':'Working for'} {elapsedTime(turn.startedAt,turn.endedAt,now)}<ChevronRight size={13} className={open?'activity-chevron expanded':'activity-chevron'}/></button></div>{open&&<div className="turn-process" aria-label="执行过程">{turn.process.map(item=>'kind'in item?<ToolCalls key={item.id} group={item}/>:item.role==='user'?<div className="message user" key={item.id}><div className="bubble"><Markdown text={item.text} onOpenLink={onOpenLink}/></div></div>:<div className={`process-message ${item.phase==='reasoning'?'reasoning-message':''}`} key={item.id}><Markdown text={item.text} onOpenLink={onOpenLink}/></div>)}</div>}{turn.completed&&<div className="turn-divider" role="separator"/>}</>}{turn.final.length>0&&<div className="turn-results" aria-label="最终回答">{turn.final.map(item=><Answer key={item.id} item={item} onOpenLink={onOpenLink}/>)}</div>}</div>;
}
export function ChatTranscript({events,runs,currentRunId,onOpenLink}:TranscriptProps){
 const turns=useMemo(()=>transcriptTurns(events,runs,currentRunId),[events,runs,currentRunId]);
 return <div className="chat-transcript">{turns.map(turn=><Turn key={turn.id} turn={turn} onOpenLink={onOpenLink}/>)}</div>;
}
