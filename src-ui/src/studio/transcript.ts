import {executionTimeline,record,type TimelineItem,type ToolKind} from '../workbench/events';
import type {WorkEvent,WorkRun} from '../workbench/types';
export type ToolGroup={kind:'tools';id:string;items:TimelineItem[]};
export type ProcessItem=TimelineItem|ToolGroup;
export type TranscriptTurn={id:string;user:TimelineItem[];process:ProcessItem[];final:TimelineItem[];generated:TimelineItem[];completed:boolean;startedAt?:string;endedAt?:string};
export function groupTools(items:TimelineItem[]):ProcessItem[]{
 const grouped:ProcessItem[]=[];
 for(const item of items){const last=grouped[grouped.length-1];if(item.role==='tool'){if(last&&'kind'in last)last.items.push(item);else grouped.push({kind:'tools',id:`tools:${item.id}`,items:[item]})}else grouped.push(item)}
 return grouped;
}
const keyFor=(run?:string,thread?:string,turn?:string)=>`${run||'legacy'}:${thread||'main'}:${turn||'turn'}`;

function reconcileUserEchoes(timeline:TimelineItem[],roots:Map<string,string>):TimelineItem[]{
 const visible:TimelineItem[]=[];
 const pending=new Map<string,{positions:number[];next:number}>();
 for(const item of timeline){
  // 自动会话先记下发送，再收到同一执行的协议回显。只消费一条记录，保留真正发了两次的同文消息。
  if(item.role==='user'&&item.runId&&item.text){
   const key=`${item.runId}\0${item.text}`;
   if(item.userSource==='local'){
    const queue=pending.get(key)??{positions:[],next:0};
    queue.positions.push(visible.length);
    pending.set(key,queue);
   }else if(item.userSource==='protocol'&&(!item.threadId||roots.get(item.runId)===item.threadId)){
    const queue=pending.get(key),position=queue?.positions[queue.next];
    if(queue&&position!==undefined){
     queue.next++;
     const local=visible[position];
     // 旧自动会话只保存文字，回显仍是附件快照的来源。
     if(!local.images?.length&&!local.imageRefs?.length&&!local.unavailableImages){
      visible[position]={...local,images:item.images,imageRefs:item.imageRefs,unavailableImages:item.unavailableImages};
     }
     continue;
    }
   }
  }
  visible.push(item);
 }
 return visible;
}

/** 主线程结果与子Agent记录隔离，用户中途补充保留在原事件位置。 */
export function transcriptTurns(events:WorkEvent[],runs:WorkRun[],currentRunId?:string|null):TranscriptTurn[]{
 const timeline=executionTimeline(events),starts=new Map<string,string>(),ends=new Map<string,string>();
 const groups:{id:string;key:string;items:TimelineItem[];first:boolean}[]=[];
 const seen=new Set<string>();
 const roots=new Map(runs.filter(r=>r.thread_id).map(r=>[r.id,r.thread_id!]));
 for(const item of timeline)if(item.runId&&item.threadId&&!roots.has(item.runId))roots.set(item.runId,item.threadId);
 for(const event of events){
  const p=record(event.payload),params=Object.keys(record(p.params)).length?record(p.params):p,method=p.method||event.kind,turn=record(params.turn);
  const key=keyFor(event.run_id||undefined,String(params.threadId||roots.get(event.run_id||'')||'main'),String(params.turnId||turn.id||'turn'));
  if(method==='turn/started')starts.set(key,event.created_at);if(method==='turn/completed')ends.set(key,event.created_at);
 }
 const lastRoot=new Map<string,string>(),children=new Map<string,TimelineItem>();
 const append=(key:string,item:TimelineItem)=>{
  const group=groups[groups.length-1];
  const previous=group?.items[group.items.length-1];
  const afterUserBoundary=item.role==='user'&&previous?.role!=='user';
  const afterAnswer=previous?.phase==='final_answer'&&item.phase!=='final_answer'&&item.phase!=='generated_image';
  if(group?.key===key&&!afterUserBoundary&&!afterAnswer){
   group.items.push(item);
   return;
  }
  // 协议允许同一轮内继续对话。按可见消息切段，避免最终答复被搬到下一条输入之后。
  const first=!seen.has(key);
  groups.push({id:first?key:`${key}:${item.id}`,key,items:[item],first});
  seen.add(key);
 };
 for(const item of reconcileUserEchoes(timeline,roots)){
  // 没有runId的人工输入仅在时间明确落入一次执行时才归入该过程。
  const at=Date.parse(item.createdAt||'');
  const runId=item.runId||(item.role==='user'?runs.find(r=>Date.parse(r.started_at)<=at&&(!r.ended_at||Date.parse(r.ended_at)>=at))?.id:undefined);
  const root=roots.get(runId||''),run=runs.find(r=>r.id===runId);
  if(item.threadId&&root&&item.threadId!==root){
   const parent=lastRoot.get(runId||'')||keyFor(runId,root,run?.turn_id||undefined),childKey=keyFor(runId,item.threadId,item.turnId);
   let child=children.get(childKey);
   if(!child){child={id:`agent:${childKey}`,role:'tool',toolKind:'agent',runId,threadId:root,turnId:run?.turn_id||undefined,createdAt:item.createdAt,title:'智能体执行记录',label:`智能体 ${item.threadId.slice(-8)}`,text:'',status:ends.has(childKey)?'completed':'inProgress',endedAt:ends.get(childKey),children:[]};children.set(childKey,child);append(parent,child)}
   child.children!.push(item);continue;
  }
  if(item.role==='user'&&!item.turnId){
   const current=lastRoot.get(runId||''),ended=current?ends.get(current):undefined;
   if(current&&(!ended||Date.parse(ended)>=at))append(current,item);
   else append(`user:${item.id}`,item);
   continue;
  }
  const key=item.turnId?keyFor(runId,root||item.threadId,item.turnId):lastRoot.get(runId||'')||keyFor(runId,root);
  if(item.role!=='user')lastRoot.set(runId||'',key);
  append(key,item);
 }
 return groups.map(({id,key,items,first},index)=>{
  const run=runs.find(r=>r.id===items[0].runId),end=ends.get(key);
  const completed=Boolean(end||run?.ended_at||run&&['completed','failed','interrupted','superseded','cancelled'].includes(run.status))||!currentRunId||Boolean(items[0].runId&&items[0].runId!==currentRunId);
  const answers=items.filter(i=>i.role==='agent'),explicit=answers.filter(i=>i.phase==='final_answer'),fallback=answers[answers.length-1];
  const final=explicit.length?explicit:fallback&&!fallback.phase&&completed?[fallback]:[];
  // 生图是答复产物，完成后仍须在折叠的执行过程之外可见。
  const generated=items.filter(i=>i.phase==='generated_image');
  let leading=0;while(leading<items.length&&items[leading].role==='user')leading++;
  const next=groups[index+1];
  const boundary=next?.key===key?next.items[0].createdAt:undefined;
  const stableId=final.length ? 'answer:'+final[final.length-1].id : leading ? 'input:'+items[0].id : id;
  return {id:stableId,user:items.slice(0,leading),process:groupTools(items.slice(leading).filter(i=>!final.includes(i)&&i.phase!=='generated_image')),final,generated,completed,startedAt:(first&&(starts.get(key)||run?.started_at))||items[0].createdAt,endedAt:boundary||end||run?.ended_at||undefined};
 });
}
export const toolKinds:Record<ToolKind,string>={read:'读取',search:'搜索',command:'执行',edit:'编辑',agent:'智能体',computer:'电脑任务',tool:'工具'};
export function toolSummary(items:TimelineItem[]):string{
 const counts=new Map<ToolKind,number>();for(const item of items){const kind=item.toolKind||'tool';counts.set(kind,(counts.get(kind)||0)+1)}
 return [...counts].map(([kind,count])=>`${toolKinds[kind]} ${count} ${kind==='read'||kind==='edit'?'个文件':kind==='command'?'条命令':'次'}`).join(' · ');
}
export function elapsedTime(start?:string,end?:string,now=Date.now()):string{
 const a=Date.parse(start||''),b=end?Date.parse(end):now;if(!Number.isFinite(a)||!Number.isFinite(b))return '用时未知';
 const seconds=Math.max(0,Math.floor((b-a)/1000)),minutes=Math.floor(seconds/60);return minutes?`${minutes}分钟${seconds%60}秒`:`${seconds}秒`;
}
