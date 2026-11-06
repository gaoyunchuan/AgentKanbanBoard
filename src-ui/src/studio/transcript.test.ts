import {expect,test} from 'vitest';
import {transcriptTurns} from './transcript';
import type {WorkEvent,WorkRun} from '../workbench/types';
const run:WorkRun={id:'r',task_id:'t',thread_id:'main',turn_id:'main-turn',generation:1,prompt:'work',status:'running',started_at:'2026-10-30T10:00:00Z'};
const item=(id:number,threadId:string,turnId:string,text:string,phase='commentary'):WorkEvent=>({id,task_id:'t',run_id:'r',kind:'item/completed',created_at:`2026-10-30T10:00:0${id}Z`,payload:{threadId,turnId,item:{id:`m${id}`,type:'agentMessage',text,phase}}});
const user=(id:number,text:string):WorkEvent=>({id,task_id:'t',run_id:'r',kind:'user_message',created_at:`2026-10-30T10:00:0${id}Z`,payload:{text}});
test('子Agent的final留在折叠的智能体过程，不冒充主会话结果',()=>{
 const turns=transcriptTurns([user(1,'请求'),item(2,'main','main-turn','核对代码'),item(3,'child','child-turn','内部子任务结果','final_answer'),item(4,'main','main-turn','用户可见的结果','final_answer')],[run],'r');
 expect(turns.flatMap(t=>t.final.map(i=>i.text))).toEqual(['用户可见的结果']);
 expect(JSON.stringify(turns.flatMap(t=>t.process))).toContain('内部子任务结果');
});
test('无 turnId 的中途补充保留在前后过程之间',()=>{
 const turns=transcriptTurns([user(1,'最初请求'),item(2,'main','main-turn','过程开头'),user(3,'中途补充'),item(4,'main','main-turn','收到补充')],[run],'r');
 const visible=turns.flatMap(t=>[...t.user,...t.process,...t.final]);
 expect(visible.map(i=>'text'in i?i.text:'')).toEqual(['最初请求','过程开头','中途补充','收到补充']);
 expect(turns.flatMap(t=>t.user.map(i=>i.text))).toEqual(['最初请求','中途补充']);
});

test('历史中保留用户的任务问题回复与返工留言',()=>{
 const answer:WorkEvent={...user(2,''),kind:'question_answered',payload:{response:{text:'先查告警规则'}}};
 const feedback:WorkEvent={...user(4,''),run_id:null,kind:'task_action',payload:{action:'rework',feedback:'补上原始证据'}};
 const pause:WorkEvent={...user(5,''),kind:'task_action',payload:{action:'pause'}};
 const turns=transcriptTurns([user(1,'检查机器'),answer,item(3,'main','main-turn','已核对','final_answer'),feedback,pause],[run]);
 expect(turns.flatMap(t=>t.user.map(i=>i.text))).toEqual(['检查机器','先查告警规则','补上原始证据']);
});

test('向上接入同回合更早输入后，仍用同一标识渲染已经显示的最终回答',()=>{
 const final=item(5,'main','main-turn','完整结果','final_answer');
 const recent=transcriptTurns([final],[run]).find(t=>t.final.length);
 const older:WorkEvent={...user(2,'中途输入'),kind:'item/completed',payload:{threadId:'main',turnId:'main-turn',item:{id:'older-input',type:'userMessage',content:[{type:'text',text:'中途输入'}]}}};
 const merged=transcriptTurns([item(1,'main','main-turn','检查'),older,final],[run]).find(t=>t.final.length);
 expect(merged?.id).toBe(recent?.id);
});

test('大型协议回显合并到已发送气泡时保留全部图片引用',()=>{
 const echo:WorkEvent={...item(2,'main','main-turn',''),payload:{
  threadId:'main',turnId:'main-turn',item_type:'userMessage',item_id:'echo',preview:'带图消息',image_slots:[1,2,3],
 }};
 const projected={...echo,truncated:true};
 const bubbles=transcriptTurns([user(1,'带图消息'),projected],[run]).flatMap(turn=>turn.user);
 expect(bubbles).toHaveLength(1);
 expect(bubbles[0].imageRefs).toEqual([1,2,3].map(slot=>({eventId:2,slot})));
});
