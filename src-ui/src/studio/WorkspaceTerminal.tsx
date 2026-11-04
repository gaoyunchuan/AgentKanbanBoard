import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {Terminal} from '@xterm/xterm';
import type {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './workspace-tools.css';
let terminalBundle:Promise<[typeof import('@xterm/xterm'),typeof import('@xterm/addon-fit')]>;
const loadTerminal=()=>terminalBundle??=Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit')]);
export type TerminalHandle={close:()=>Promise<void>};
type Session={id:string;workspace:string};
type Output={start:number;offset:number;dataBase64:string;exited:boolean;exitCode?:number;error?:string};
type Run={session:Promise<Session>;ready?:Promise<void>;live:boolean;closed:boolean;closing?:Promise<void>;offset:number;terminal?:Terminal;fit?:FitAddon;input:Promise<void>;dispose?:()=>void};
function terminalCall<T>(taskId:string,method:string,params:Record<string,unknown>={}){return invoke<T>('workspace_terminal',{taskId,method,...params})}
async function closeRun(taskId:string,run:Run):Promise<void>{
 if(run.closed)return;if(run.closing)return run.closing;
 // 启动被拒绝时没有后端资源；关闭失败标签不应重放同一个启动错误。
 run.closing=run.session.then(value=>terminalCall(taskId,'close',{id:value.id}),()=>undefined).then(()=>{run.closed=true}).finally(()=>{run.closing=undefined});
 return run.closing;
}
export const WorkspaceTerminal=forwardRef<TerminalHandle,{taskId:string;workspace:string;active:boolean;enabled:boolean}>(function WorkspaceTerminal({taskId,workspace,active,enabled},ref){
 const element=useRef<HTMLDivElement>(null),current=useRef<Run>();
 const [error,setError]=useState(''),[exited,setExited]=useState(false),[starting,setStarting]=useState(enabled);
 useImperativeHandle(ref,()=>({close:()=>current.current?closeRun(taskId,current.current):Promise.resolve()}));
 useEffect(()=>{
  if(!enabled)return;
  // 每次挂载独立拥有自己的请求和清理；StrictMode 的旧清理不能关闭或标记新 PTY。
  const run:Run={session:terminalCall<Session>(taskId,'start'),live:true,closed:false,offset:0,input:Promise.resolve()};current.current=run;
  const fail=(cause:unknown)=>{if(run.live&&current.current===run)setError(String(cause))};
  run.ready=(async()=>{
   try{
    const value=await run.session;
    if(!run.live){await closeRun(taskId,run);return}
    const [{Terminal},{FitAddon}]=await loadTerminal();
    if(!run.live){await closeRun(taskId,run);return}
    const term=new Terminal({cursorBlink:true,fontSize:13,fontFamily:'"SF Mono", Menlo, Monaco, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace',scrollback:3000,theme:{background:'#ffffff',foreground:'#30415a',cursor:'#507dd1',selectionBackground:'#d9e7ff'}});
    const fit=new FitAddon();run.terminal=term;run.fit=fit;term.loadAddon(fit);term.open(element.current!);
    const input=term.onData(text=>{run.input=run.input.then(async()=>{if(!run.closed)await terminalCall(taskId,'write',{id:value.id,text})}).catch(fail)});
    const resize=term.onResize(size=>{void terminalCall(taskId,'resize',{id:value.id,cols:size.cols,rows:size.rows}).catch(fail)});
    run.dispose=()=>{input.dispose();resize.dispose();term.dispose()};setStarting(false);
   }catch(cause){fail(cause);if(run.live)setStarting(false)}
  })();
  return()=>{run.live=false;void closeRun(taskId,run).catch(()=>{});run.dispose?.()};
 },[taskId,workspace,enabled]);
 useEffect(()=>{
  const run=current.current;if(!active||!enabled||!run)return;let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{
   await run.ready;if(cancelled||run.closed||!run.terminal)return;
   try{
    const value=await run.session,result=await terminalCall<Output>(taskId,'read',{id:value.id,after:run.offset});
    if(cancelled)return;
    if(result.start>run.offset)run.terminal.write('\r\n[较早输出已超过保留上限]\r\n');
    if(result.dataBase64)run.terminal.write(Uint8Array.from(atob(result.dataBase64),x=>x.charCodeAt(0)));
    run.offset=result.offset;
    if(result.error)setError(result.error);
    if(result.exited){setExited(true);run.terminal.options.disableStdin=true;run.terminal.write(`\r\n[终端已退出${result.exitCode===undefined?'':` · ${result.exitCode}`} ]\r\n`);return}
    timer=setTimeout(()=>void tick(),250);
   }catch(cause){if(!cancelled)setError(String(cause))}
  };
  void tick();return()=>{cancelled=true;if(timer)clearTimeout(timer)};
 },[active,enabled,taskId,workspace]);
 useEffect(()=>{
  const run=current.current;if(!active||!element.current||!run)return;
  const resize=()=>{if(element.current&&element.current.clientWidth>0&&run.live){run.fit?.fit();run.terminal?.focus()}};
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(resize);observer?.observe(element.current);
  void run.ready?.then(resize);return()=>observer?.disconnect();
 },[active,enabled,taskId,workspace]);
 return <section className="workspace-terminal" aria-label="项目终端"><div className="workspace-tool-toolbar"><span className="workspace-path" title={workspace}>{workspace}</span><span className="grow"/><span className="muted">{starting?'正在启动…':exited?'已退出':'终端'}</span></div>{error&&<div className="workspace-tool-error" role="alert">{error}</div>}<div className="workspace-terminal-screen" ref={element}/>{!enabled&&<p className="note">请在桌面应用中使用项目终端。</p>}</section>;
});
