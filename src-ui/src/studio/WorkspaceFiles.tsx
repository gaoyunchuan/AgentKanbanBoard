import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import './workspace-tools.css';
type Entry={fileName:string;isDirectory:boolean;isFile:boolean};
type Preview={path:string;text?:string;image?:string};
const join=(parent:string,name:string)=>`${parent.replace(/[\\/]+$/,'')}/${name}`;
export function WorkspaceFiles({taskId,workspace,enabled,openRequest}:{taskId:string;workspace:string;enabled:boolean;openRequest?:{target:string;sequence:number}}){
 const [directories,setDirectories]=useState<Record<string,Entry[]>>({}),[expanded,setExpanded]=useState<Set<string>>(new Set());
 const [preview,setPreview]=useState<Preview>(),[showTree,setShowTree]=useState(true),[filter,setFilter]=useState('');
 const [error,setError]=useState(''),[loading,setLoading]=useState(false);
 const generation=useRef(0),fileRequest=useRef(0);
 const loadDirectory=async(path:string,epoch=generation.current)=>{
  try{const result=await invoke<{entries:Entry[]}>('workbench_list_directory',{taskId,path});
   if(epoch===generation.current)setDirectories(value=>({...value,[path]:(result.entries||[]).sort((a,b)=>Number(b.isDirectory)-Number(a.isDirectory)||a.fileName.localeCompare(b.fileName))}));
  }catch(cause){if(epoch===generation.current)setError(String(cause))}
 };
 useEffect(()=>{
  const epoch=++generation.current;fileRequest.current++;setDirectories({});setExpanded(new Set());setPreview(undefined);setError('');setLoading(false);
  if(enabled&&workspace)void loadDirectory(workspace,epoch);
  return()=>{generation.current++;fileRequest.current++};
 },[taskId,workspace,enabled]);
 const toggleDirectory=(path:string)=>{
  setExpanded(value=>{const next=new Set(value);next.has(path)?next.delete(path):next.add(path);return next});
  if(!directories[path])void loadDirectory(path);
 };
 const openFile=async(path:string)=>{
  const epoch=generation.current,request=++fileRequest.current;setLoading(true);setError('');
  try{
   const result=await invoke<{dataBase64:string}>('workbench_read_file',{taskId,path});
   if(epoch!==generation.current||request!==fileRequest.current)return;
   if(typeof result.dataBase64!=='string')throw new Error('文件读取未返回有效数据');
   if(result.dataBase64.length>4_000_000)throw new Error('文件过大，请使用终端按范围查看');
   const mime:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
   const image=mime[path.split('.').pop()?.toLowerCase()||''];
   if(image)setPreview({path,image:`data:${image};base64,${result.dataBase64}`});
   else{const bytes=Uint8Array.from(atob(result.dataBase64),x=>x.charCodeAt(0));if(bytes.includes(0))throw new Error('二进制文件无法以文本预览');setPreview({path,text:new TextDecoder().decode(bytes)})}
  }catch(cause){if(epoch===generation.current&&request===fileRequest.current)setError(String(cause))}
  finally{if(epoch===generation.current&&request===fileRequest.current)setLoading(false)}
 };
 const appliedLink=useRef<number>();
 useEffect(()=>{
  if(!enabled||!openRequest||appliedLink.current===openRequest.sequence)return;
  appliedLink.current=openRequest.sequence;
  let path=openRequest.target;try{path=decodeURIComponent(path)}catch{/* 保留无法解码的原始路径。 */}
  path=path.replace(/(?::\d+)(?::\d+)?$/,'');
  if(!/^(\/|[A-Za-z]:[\\/])/.test(path))path=join(workspace,path);
  void openFile(path);
 },[openRequest,enabled,taskId,workspace]);
 const matches=(path:string,entry:Entry):boolean=>!filter||entry.fileName.toLowerCase().includes(filter.toLowerCase())||Boolean(entry.isDirectory&&directories[path]?.some(child=>matches(join(path,child.fileName),child)));
 const renderDirectory=(path:string,depth=0)=>directories[path]?.filter(entry=>matches(join(path,entry.fileName),entry)).map(entry=>{
  const child=join(path,entry.fileName),open=expanded.has(child)||Boolean(filter&&directories[child]);
  return <div key={child} role="treeitem" aria-expanded={entry.isDirectory?open:undefined} aria-selected={preview?.path===child}>
   <button className={`workspace-tree-entry ${preview?.path===child?'selected':''}`} style={{paddingLeft:depth*14+8}} aria-label={entry.isDirectory?`${open?'折叠':'展开'} ${entry.fileName}`:entry.fileName} title={child} onClick={()=>entry.isDirectory?toggleDirectory(child):void openFile(child)}>
    {entry.isDirectory?<>{open?<ChevronDown size={12}/>:<ChevronRight size={12}/>}<Folder size={14}/></>:<><span className="tree-indent"/><File size={13}/></>}<span>{entry.fileName}</span>
   </button>{entry.isDirectory&&open&&<div role="group">{renderDirectory(child,depth+1)}</div>}
  </div>;
 });
 return <section className="workspace-files" aria-label="文件工作区">
  <div className="workspace-tool-toolbar"><span className="workspace-path" title={preview?.path||workspace}>{preview?.path?.replace(`${workspace}/`,'')||workspace||'文件'}</span><span className="grow"/>{loading&&<LoaderCircle size={14} className="spin"/>}<button className="iconbtn" aria-label="刷新目录" onClick={()=>void loadDirectory(workspace)} disabled={!enabled}><RefreshCw size={14}/></button><button className={`iconbtn ${showTree?'selected':''}`} aria-label={showTree?'收起目录树':'展开目录树'} aria-expanded={showTree} onClick={()=>setShowTree(value=>!value)}><FolderOpen size={17}/></button></div>
  {error&&<div role="alert" className="workspace-tool-error">{error}</div>}
  <div className="workspace-files-layout"><div className="workspace-file-content">
   {preview?.image?<img src={preview.image} alt={preview.path.split('/').pop()}/>:preview?.text!==undefined?<pre className="workspace-code">{preview.text.split('\n').map((line,index)=><div className="workspace-code-line" key={index}><span className="workspace-line-number">{index+1}</span><code>{line||' '}</code></div>)}</pre>:<div className="workspace-tool-empty"><FolderOpen size={30}/><h3>打开文件</h3><p>{enabled?'从右侧项目目录树选择文件':'请在桌面应用中查看项目文件'}</p></div>}
  </div><aside className="workspace-file-tree" aria-label="项目目录树" hidden={!showTree}><label className="workspace-file-filter"><Search size={13}/><input aria-label="筛选文件" placeholder="筛选已加载文件…" value={filter} onChange={e=>setFilter(e.target.value)}/></label><div className="workspace-tree-root" title={workspace}><Folder size={13}/>{workspace.split('/').filter(Boolean).pop()}</div><div role="tree" aria-label="项目文件">{renderDirectory(workspace)}</div>{enabled&&!directories[workspace]&&<p className="note">正在读取目录…</p>}</aside></div>
 </section>;
}
