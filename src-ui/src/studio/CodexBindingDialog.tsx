import {useEffect,useRef,useState} from 'react';
import {Check,Folder,MessageSquare,Search} from 'lucide-react';
import {Modal} from './components';
import {useStudio} from './context';
import type {Conversation} from './model';
import './codex-binding.css';

export type CodexThread={id:string;name:string;cwd:string;updated_at:number;status:string;archived:boolean};
type Page={data:CodexThread[];nextCursor:string|null};

export function CodexBindingDialog({taskId,onClose}:{taskId:string;onClose:()=>void}){
 const s=useStudio();
 // 右键目标不依赖当前选中行，列表返回时也不能绑定到后来切换的任务。
 const [target]=useState(()=>s.data.tasks.find(t=>t.id===taskId));
 const [input,setInput]=useState(''),[query,setQuery]=useState(''),[archived,setArchived]=useState(false);
 const [cursors,setCursors]=useState<(string|null)[]>([null]),[retry,setRetry]=useState(0);
 const [page,setPage]=useState<Page>({data:[],nextCursor:null}),[selected,setSelected]=useState<string>();
 const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const request=useRef(0),cursor=cursors[cursors.length-1];
 useEffect(()=>{
  const seq=++request.current;setLoading(true);setError('');setSelected(undefined);
  void s.api.call<Page>('codex_threads',{query,archived,cursor}).then(value=>{
   if(request.current===seq)setPage(value);
  }).catch(e=>{if(request.current===seq){setPage({data:[],nextCursor:null});setError(String(e))}})
   .finally(()=>{if(request.current===seq)setLoading(false)});
  return()=>{request.current++};
 },[s.api,query,archived,cursor,retry]);
 const current=s.data.tasks.find(t=>t.id===target?.id);
 const unavailable=!current?'目标任务已删除，请关闭后重新选择': ['completed','cancelled'].includes(current.status)?'请先重新打开任务，再绑定会话':undefined;
 const candidate=page.data.find(t=>t.id===selected);
 const existing=s.data.conversations.find(c=>c.thread_id===selected);
 const other=existing&&existing.task_id!==taskId;
 const submit=async()=>{
  if(!candidate||unavailable||other||saving)return;
  setSaving(true);setError('');
  try{
   const c=existing??await s.command<Conversation>('bind_codex_thread',{task_id:taskId,thread_id:candidate.id},'已绑定原会话；完成归档交接后可继续聊天');
   s.openConversation(c.id);onClose();
  }catch(e){setError(String(e))}finally{setSaving(false)}
 };
 const filter=(value:boolean)=>{setArchived(value);setCursors([null])};
 return <Modal title="绑定 Codex 会话" wide onClose={()=>{if(!saving)onClose()}} footer={<>
  <button className="textbtn outlined" disabled={saving} onClick={onClose}>取消</button>
  <button className="textbtn primary" disabled={!candidate||loading||saving||s.busy||Boolean(unavailable)||Boolean(other)} onClick={()=>void submit()}>{saving?'正在绑定…':existing?'打开已有会话':'绑定并查看历史'}</button>
 </>}>
  <p className="modal-desc">绑定到「{target?.title||'已不可见任务'}」。保留 Codex 原会话和工作目录；绑定后先查看历史，再归档交接。</p>
  <form className="codex-search" onSubmit={e=>{e.preventDefault();setQuery(input.trim());setCursors([null]);if(input.trim()===query)setRetry(n=>n+1)}}><Search size={15}/><input aria-label="搜索 Codex 会话" placeholder="按会话名称搜索" value={input} onChange={e=>setInput(e.target.value)} maxLength={300}/><button className="textbtn outlined" type="submit" disabled={saving}>搜索</button></form>
  <div className="codex-catalog-tabs" aria-label="Codex 会话范围"><button aria-pressed={!archived} disabled={saving} onClick={()=>filter(false)}>活动会话</button><button aria-pressed={archived} disabled={saving} onClick={()=>filter(true)}>已归档</button><span>来自本机 Codex</span></div>
  {unavailable&&<p className="warning-box">{unavailable}</p>}
  <div className="codex-catalog" aria-busy={loading}>{loading?<p className="note" role="status">正在读取 Codex 会话…</p>:page.data.map(t=>{
   const bound=s.data.conversations.find(c=>c.thread_id===t.id),owner=s.data.tasks.find(task=>task.id===bound?.task_id);
   const disabled=t.status==='active'||Boolean(bound&&bound.task_id!==taskId);
   return <button className={`codex-candidate ${t.id===selected?'chosen':''}`} key={t.id} disabled={disabled||saving} aria-pressed={t.id===selected} onClick={()=>setSelected(t.id)}>
    <MessageSquare size={17}/><span className="grow"><strong>{t.name||'未命名会话'}</strong><small><Folder size={12}/>{t.cwd}</small><small>{bound?bound.task_id===taskId?'已绑定当前任务':`已绑定「${owner?.title||'其他任务'}」`:t.status==='active'?'正在 Codex 执行，请等待结束':t.updated_at?new Date(t.updated_at*1000).toLocaleString('zh-CN'):'更新时间未知'}</small></span>{t.id===selected&&<Check size={16}/>}
   </button>
  })}{!loading&&!page.data.length&&!error&&<p className="note">没有匹配的主会话。可切换归档范围或修改搜索。</p>}</div>
  <div className="codex-page-actions"><button className="textbtn" disabled={loading||saving||cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>上一页</button><span>第 {cursors.length} 页</span><button className="textbtn" disabled={loading||saving||!page.nextCursor||page.nextCursor===cursor} onClick={()=>setCursors(c=>[...c,page.nextCursor])}>下一页</button></div>
  {error&&<div className="form-error" role="alert">{error}<button className="textbtn" disabled={loading||saving} onClick={()=>setRetry(n=>n+1)}>重试</button></div>}
 </Modal>;
}
