import React,{useEffect,useRef,useState} from "react";
import { createPortal } from "react-dom";
import { X,FileText,MessageSquare,ArrowUpRight } from "lucide-react";
import type { StudioTask,Workspace,Conversation } from "./model";
import { ancestors,flattenedTasks,rootId,visibleResults } from "./model";

export {Markdown} from "./Markdown";
import {Markdown} from "./Markdown";

export function Modal({title,children,footer,onClose,wide=false,initialFocus}:{title:string;children:React.ReactNode;footer?:React.ReactNode;onClose:()=>void;wide?:boolean;initialFocus?:React.RefObject<HTMLElement>}) {
  const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const old=document.activeElement as HTMLElement|null;const dialog=ref.current;
    const target=initialFocus?.current??dialog?.querySelector<HTMLElement>('input,textarea,select,button,[tabindex="0"]');
    target?.focus();
    const handler=(e:KeyboardEvent)=>{
      // portal 列表的键盘事件归其自身，不能误触发外层弹窗关闭或焦点环。
      if(e.defaultPrevented||(e.target instanceof Node&&!dialog?.contains(e.target)))return;
      if(e.key==="Escape"){e.preventDefault();close.current();}if(e.key==="Tab"&&dialog){const all=Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(el=>el.offsetParent!==null);const first=all[0],last=all[all.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener("keydown",handler);return()=>{document.removeEventListener("keydown",handler);old?.focus();};},[initialFocus]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`modal ${wide?"wide":""}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="关闭对话框"><X/></button></header><div className="modal-body">{children}</div>{footer&&<footer className="modal-footer">{footer}</footer>}</div></div>;
}
export function HoverInfo({children,task,conversation,data,onOpen,onResults,onTask}:{children:React.ReactNode;task:StudioTask;conversation?:Conversation|boolean;data:Workspace;onOpen:()=>void;onResults?:()=>void;onTask?:(id:string)=>void}) {
  const [position,setPosition]=useState<{top:number;left:number}>();const timer=useRef<ReturnType<typeof setTimeout>>(),anchor=useRef<HTMLSpanElement>(null);
  const cancel=()=>{if(timer.current)clearTimeout(timer.current)};
  const show=()=>{cancel();timer.current=setTimeout(()=>{const r=anchor.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(12,Math.min(innerWidth-368,r.right+12)),top:Math.max(12,Math.min(innerHeight-420,r.top))});},330);};
  const hide=()=>{cancel();timer.current=setTimeout(()=>setPosition(undefined),180);};
  useEffect(()=>()=>cancel(),[]);
  useEffect(()=>{if(!position)return;const key=(e:KeyboardEvent)=>{if(e.key==="Escape")setPosition(undefined)};const scroll=()=>setPosition(undefined);document.addEventListener("keydown",key);window.addEventListener("resize",scroll);return()=>{document.removeEventListener("keydown",key);window.removeEventListener("resize",scroll)};},[position]);
  const results=visibleResults(task).slice(-2);const root=rootId(data.tasks,task.id);
  return <span className="hover-host hover-anchor" ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>{children}{position&&createPortal(<div className="studio hover-portal"><div className="hover-card" role="dialog" aria-label={conversation?"关联任务树":"任务上下文与结果"} style={position} onMouseEnter={cancel} onMouseLeave={hide} onFocus={cancel} onBlur={hide}>
    <div className="hover-eyebrow">{conversation?"会话关联的任务树":"任务信息"}</div>
    {conversation?<>{flattenedTasks(data.tasks).filter(row=>rootId(data.tasks,row.task.id)===root).map(({task:t,depth})=><button type="button" onClick={()=>{setPosition(undefined);onTask?.(t.id)}} key={t.id} className={`hover-tree-row ${t.id===task.id?"current":""}`} style={{paddingLeft:8+depth*16}}><MessageSquare size={13}/><span className="truncate">{t.title}</span>{t.id===task.id&&<small>本会话</small>}</button>)}</>:<><div className="hover-title">{task.title}</div><div className="hovercard-section">上下文</div><div className="hover-markdown"><Markdown text={task.process_tracking||"尚未添加上下文"}/></div><div className="hovercard-section">结果 · {task.results.filter(r=>r.status!=="withdrawn").length} 条</div><div className="hover-markdown">{results.length?results.map(r=><div key={r.id}><small>{r.conversation_title}</small><Markdown text={r.markdown.slice(0,240)}/></div>):"尚未沉淀结果"}</div></>}
    <div className="hovercard-footer"><button onClick={()=>{setPosition(undefined);onOpen()}}>{conversation?"在任务树中定位":"打开任务详情"}<ArrowUpRight size={12}/></button><span className="grow"/><button onClick={()=>{setPosition(undefined);(onResults||onOpen)()}}>查看全部结果</button></div>
  </div></div>,document.body)}</span>;
}
export function FormField({label,children,note}:{label:string;children:React.ReactNode;note?:string}){return <div className="field"><div className="field-label">{label}</div>{children}{note&&<p className="note">{note}</p>}</div>}
export function EmptyPanel({text}:{text:string}){return <div className="empty-panel"><FileText/><p>{text}</p></div>}
