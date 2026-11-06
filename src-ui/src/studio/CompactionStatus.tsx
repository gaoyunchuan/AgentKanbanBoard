import {useEffect,useState} from 'react';
import {CircleCheck,LoaderCircle} from 'lucide-react';
import type {TimelineItem} from '../workbench/events';
import {elapsedTime} from './transcript';

/** 压缩完成或执行结束都停止计时；只把收到完成事件的压缩标为成功。 */
export function CompactionStatus({item,completed,endedAt}:{item:TimelineItem;completed:boolean;endedAt?:string}){
 const active=item.status!=='completed'&&!completed;
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{
  setNow(Date.now());
  if(!active)return;
  const timer=setInterval(()=>setNow(Date.now()),1000);
  return()=>clearInterval(timer);
 },[active,item.startedAt]);
 const label=active?'正在压缩上下文':item.status==='completed'?'上下文压缩完成':'上下文压缩已结束';
 const end=item.endedAt||(completed?endedAt||new Date(now).toISOString():undefined);
 return <div className="context-compaction">{active?<LoaderCircle size={13} className="spin" aria-hidden="true"/>:item.status==='completed'?<CircleCheck size={13} aria-hidden="true"/>:null}<span role="status">{label}</span><span role="timer" aria-live="off">· {active?'已用时':'耗时'} {elapsedTime(item.startedAt||item.createdAt,end,now)}</span></div>;
}
