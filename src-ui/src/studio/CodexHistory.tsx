import {useCallback,useEffect,useRef,useState} from 'react';
import {History,RefreshCw} from 'lucide-react';
import {Markdown} from './components';
import {useStudio} from './context';
import './codex-binding.css';

type HistoryItem={id:string;turn_id:string;kind:string;text:string;phase?:string|null};
type HistoryPage={data:HistoryItem[];nextCursor:string|null};
const MAX_ITEMS=800;
const key=(item:HistoryItem)=>`${item.turn_id}:${item.id}`;
const labels:Record<string,string>={commandExecution:'终端命令',fileChange:'文件变更',mcpToolCall:'工具调用',reasoning:'思考摘要',plan:'执行计划'};

export function CodexHistory({conversationId}:{conversationId:string}){
 const s=useStudio(),sequence=useRef(0);
 const [items,setItems]=useState<HistoryItem[]>([]),[next,setNext]=useState<string|null>(null);
 const [loading,setLoading]=useState(true),[error,setError]=useState('');
 const retry=useRef<{cursor:string|null;reset:boolean}>({cursor:null,reset:true});
 const load=useCallback(async(cursor:string|null,reset:boolean)=>{
  const seq=++sequence.current;retry.current={cursor,reset};setLoading(true);setError('');
  try{
   const page=await s.api.call<HistoryPage>('codex_history',{conversation_id:conversationId,cursor});
   if(seq!==sequence.current)return;
   // 游标可能跨越相同消息，刷新也不能把已有条目重复追加到时间线。
   setItems(current=>[...new Map([...page.data,...(reset?[]:current)].map(item=>[key(item),item])).values()].slice(-MAX_ITEMS));
   setNext(page.nextCursor===cursor?null:page.nextCursor);
  }catch(e){if(seq===sequence.current)setError(String(e))}finally{if(seq===sequence.current)setLoading(false)}
 },[s.api,conversationId]);
 useEffect(()=>{void load(null,true);return()=>{sequence.current++}},[load]);
 return <section className="codex-history" aria-label="Codex 原会话历史">
  <div className="codex-history-head"><History size={15}/><strong>Codex 原会话历史</strong><span className="grow"/><button className="textbtn" aria-label="刷新 Codex 历史" disabled={loading} onClick={()=>void load(null,true)}><RefreshCw size={13}/>刷新</button></div>
  <p className="note">原会话中的消息与执行记录；本应用的后续对话显示在下方。</p>
  {next&&items.length<MAX_ITEMS&&<button className="textbtn outlined codex-load-older" disabled={loading} onClick={()=>void load(next,false)}>加载更早历史</button>}
  {next&&items.length>=MAX_ITEMS&&<p className="note">已加载 800 条记录；更早内容请在 Codex 中查看。</p>}
  {loading&&<p className="note" role="status">正在读取原会话历史…</p>}
  {error&&<div className="form-error" role="alert">{error}<button className="textbtn" disabled={loading} onClick={()=>void load(retry.current.cursor,retry.current.reset)}>重试读取历史</button></div>}
  {!loading&&!error&&!items.length&&<p className="note">此页没有外部历史记录。{next?'可继续加载更早历史。':''}</p>}
  {items.map(item=>item.kind==='userMessage'?<div className="message user" key={key(item)}><div className="bubble"><Markdown text={item.text}/></div></div>:item.kind==='agentMessage'?<div className="codex-history-answer" key={key(item)}><Markdown text={item.text}/></div>:<details className="codex-history-tool" key={key(item)}><summary>{labels[item.kind]||'执行记录'}</summary><pre>{item.text}</pre></details>)}
  <div className="codex-history-end">以上为 Codex 原会话 · 接续时保留完整模型上下文</div>
 </section>;
}
