import {useEffect,useRef} from 'react';
import type {Conversation} from './model';

/** 阅读只确认当前前台会话已加载的正文边界；轮询本身不是查看动作。 */
export function useConversationRead(conversation:Conversation|undefined,session:number,atBottom:boolean,ack:(boundary:number,version:number)=>Promise<void>,openedVersion?:number){
 const entry=useRef<{id:string;session:number;version:number}>();
 const confirmed=useRef(''),pending=useRef('');
 const callback=useRef(ack);callback.current=ack;
 useEffect(()=>{
  if(!conversation)return;
  const c=conversation,version=c.read_version??0,boundary=c.last_output_event_id??0;
  if(entry.current?.id!==c.id||entry.current.session!==session){
   // 快照可能先于详情显示人工蓝点，重开时以最新快照版本建立阅读周期。
   entry.current={id:c.id,session,version:openedVersion??version};confirmed.current='';
  }
  const current=entry.current;
  const key=`${c.id}:${session}:${boundary}:${version}`;
  const read=()=>{
   if(!atBottom||!document.hasFocus()||document.visibilityState==='hidden'||!c.unread)return;
   // 当前页上人工标未读必须等重新打开，不能被下一次 detail 轮询清掉。
   if(c.manual_unread&&version!==current.version)return;
   if(confirmed.current===key||pending.current===key)return;
   pending.current=key;
   void callback.current(boundary,version).then(()=>{confirmed.current=key}).catch(()=>{
    // 下次详情轮询重试，不把本地显示抢先当成服务端已保存。
   }).finally(()=>{if(pending.current===key)pending.current=''});
  };
  read();window.addEventListener('focus',read);document.addEventListener('visibilitychange',read);
  return()=>{window.removeEventListener('focus',read);document.removeEventListener('visibilitychange',read)};
 },[conversation,session,atBottom,openedVersion]);
}
