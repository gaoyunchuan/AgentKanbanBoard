import React,{useEffect,useRef,useState} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { X,FileText,MessageSquare,ArrowUpRight } from "lucide-react";
import type { StudioTask,Workspace,Conversation } from "./model";
import { ancestors,flattenedTasks,rootId,visibleResults } from "./model";

function inline(text:string,key=""):React.ReactNode[] {
  const pattern=/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g;const out:React.ReactNode[]=[];let last=0;let match:RegExpExecArray|null;
  while((match=pattern.exec(text))){if(match.index>last)out.push(text.slice(last,match.index));const v=match[0],id=`${key}:${match.index}`;
    if(v.startsWith("`"))out.push(<code key={id}>{v.slice(1,-1)}</code>);
    else if(v.startsWith("**"))out.push(<strong key={id}>{v.slice(2,-2)}</strong>);
    else {const l=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(v)!;let valid=false;try{valid=["https:","http:"].includes(new URL(l[2]).protocol)}catch{/* Render invalid URLs as text. */}
      out.push(valid?<a key={id} href={l[2]} target="_blank" rel="noreferrer noopener" onClick={e=>{if("__TAURI_INTERNALS__" in window){e.preventDefault();void invoke("open_external_link",{target:l[2]}).catch(()=>{});}}}>{l[1]}</a>:v);}
    last=pattern.lastIndex;
  }
  if(last<text.length)out.push(text.slice(last));return out;
}
/** Markdown stays native text at rest. Rendering never executes embedded HTML. */
export function Markdown({text}:{text:string}) {
  const lines=text.split(/\r?\n/),nodes:React.ReactNode[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(!line.trim())continue;
    if(/^\s*```/.test(line)){const lang=line.replace(/^\s*```/,"").trim();const code=[];let j=i+1;while(j<lines.length&&!/^\s*```/.test(lines[j]))code.push(lines[j++]);nodes.push(<pre key={i}><span className="code-language">{lang}</span><code>{code.join("\n")}</code></pre>);i=j;continue;}
    const heading=/^(#{1,6})\s+(.+)$/.exec(line);if(heading){nodes.push(React.createElement(`h${heading[1].length}`,{key:i},inline(heading[2],String(i))));continue;}
    if(/^\s*>\s?/.test(line)){nodes.push(<blockquote key={i}>{inline(line.replace(/^\s*>\s?/,""),String(i))}</blockquote>);continue;}
    if(/^\s*([-*+]\s|\d+\.\s)/.test(line)){const entries=[];const start=i,ordered=/^\s*\d+\./.test(line);while(i<lines.length&&/^\s*([-*+]\s|\d+\.\s)/.test(lines[i])){const content=lines[i].replace(/^\s*([-*+]\s|\d+\.\s)/,"");const box=/^\[([ xX])\]\s+(.*)/.exec(content);entries.push(<li key={i}>{box?<><input type="checkbox" checked={box[1]!==" "} readOnly tabIndex={-1}/>{inline(box[2],String(i))}</>:inline(content,String(i))}</li>);i++;}i--;nodes.push(ordered?<ol key={start}>{entries}</ol>:<ul key={start}>{entries}</ul>);continue;}
    if(line.includes("|")&&i+1<lines.length&&/^\s*\|?\s*:?-{3}/.test(lines[i+1])){const cells=(s:string)=>s.trim().replace(/^\||\|$/g,"").split("|").map(x=>x.trim());const head=cells(line),rows=[];const start=i;i+=2;while(i<lines.length&&lines[i].includes("|")){rows.push(cells(lines[i]));i++;}i--;nodes.push(<div className="md-table" key={start}><table><thead><tr>{head.map((x,n)=><th key={n}>{inline(x)}</th>)}</tr></thead><tbody>{rows.map((r,n)=><tr key={n}>{r.map((x,j)=><td key={j}>{inline(x)}</td>)}</tr>)}</tbody></table></div>);continue;}
    nodes.push(<p key={i}>{inline(line,String(i))}</p>);
  }
  return <div className="markdown">{nodes}</div>;
}
export function Modal({title,children,footer,onClose,wide=false}:{title:string;children:React.ReactNode;footer?:React.ReactNode;onClose:()=>void;wide?:boolean}) {
  const ref=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const old=document.activeElement as HTMLElement|null;const dialog=ref.current;dialog?.querySelector<HTMLElement>('input,textarea,select,button,[tabindex="0"]')?.focus();
    const handler=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();close.current();}if(e.key==="Tab"&&dialog){const all=Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')).filter(el=>el.offsetParent!==null);const first=all[0],last=all[all.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};document.addEventListener("keydown",handler);return()=>{document.removeEventListener("keydown",handler);old?.focus();};},[]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={`modal ${wide?"wide":""}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="关闭对话框"><X/></button></header><div className="modal-body">{children}</div>{footer&&<footer className="modal-footer">{footer}</footer>}</div></div>;
}
export function HoverInfo({children,task,conversation,data,onOpen,onResults}:{children:React.ReactNode;task:StudioTask;conversation?:Conversation;data:Workspace;onOpen:()=>void;onResults:()=>void}) {
  const [position,setPosition]=useState<{top:number;left:number}>();const timer=useRef<ReturnType<typeof setTimeout>>(),anchor=useRef<HTMLSpanElement>(null);
  const cancel=()=>{if(timer.current)clearTimeout(timer.current)};
  const show=()=>{cancel();timer.current=setTimeout(()=>{const r=anchor.current?.getBoundingClientRect();if(r)setPosition({left:Math.max(12,Math.min(innerWidth-368,r.right+12)),top:Math.max(12,Math.min(innerHeight-420,r.top))});},330);};
  const hide=()=>{cancel();timer.current=setTimeout(()=>setPosition(undefined),180);};
  useEffect(()=>()=>cancel(),[]);
  useEffect(()=>{if(!position)return;const key=(e:KeyboardEvent)=>{if(e.key==="Escape")setPosition(undefined)};const scroll=()=>setPosition(undefined);document.addEventListener("keydown",key);window.addEventListener("resize",scroll);return()=>{document.removeEventListener("keydown",key);window.removeEventListener("resize",scroll)};},[position]);
  const results=visibleResults(task).slice(-2);const root=rootId(data.tasks,task.id);
  return <span className="hover-host hover-anchor" ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>{children}{position&&createPortal(<div className="studio hover-portal"><div className="hover-card" role="dialog" aria-label={conversation?"关联任务树":"任务上下文与结果"} style={position} onMouseEnter={cancel} onMouseLeave={hide} onFocus={cancel} onBlur={hide}>
    <div className="hover-eyebrow">{conversation?"会话关联的任务树":"任务信息"}</div>
    {conversation?<>{flattenedTasks(data.tasks).filter(row=>rootId(data.tasks,row.task.id)===root).map(({task:t,depth})=><div key={t.id} className={`hover-tree-row ${t.id===task.id?"current":""}`} style={{paddingLeft:8+depth*16}}><MessageSquare size={13}/><span className="truncate">{t.title}</span>{t.id===task.id&&<small>本会话</small>}</div>)}</>:<><div className="hover-title">{task.title}</div><div className="hovercard-section">上下文</div><div className="hover-markdown"><Markdown text={task.process_tracking||"尚未添加上下文"}/></div><div className="hovercard-section">结果 · {task.results.filter(r=>r.status!=="withdrawn").length} 条</div><div className="hover-markdown">{results.length?results.map(r=><div key={r.id}><small>{r.conversation_title}</small><Markdown text={r.markdown.slice(0,240)}/></div>):"尚未沉淀结果"}</div></>}
    <div className="hovercard-footer"><button onClick={()=>{setPosition(undefined);onOpen()}}>{conversation?"在任务树中定位":"打开任务详情"}<ArrowUpRight size={12}/></button><span className="grow"/><button onClick={()=>{setPosition(undefined);onResults()}}>查看全部结果</button></div>
  </div></div>,document.body)}</span>;
}
export function FormField({label,children,note}:{label:string;children:React.ReactNode;note?:string}){return <div className="field"><div className="field-label">{label}</div>{children}{note&&<p className="note">{note}</p>}</div>}
export function EmptyPanel({text}:{text:string}){return <div className="empty-panel"><FileText/><p>{text}</p></div>}
