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
test('真实无turnId的中途补充留在原来的过程位置',()=>{
 const turns=transcriptTurns([user(1,'最初请求'),item(2,'main','main-turn','过程开头'),user(3,'中途补充'),item(4,'main','main-turn','收到补充')],[run],'r');
 const process=turns.flatMap(t=>t.process).filter(i=>!('kind'in i));
 expect(process.map(i=>'text'in i?i.text:'')).toEqual(['过程开头','中途补充','收到补充']);
 expect(turns.flatMap(t=>t.user.map(i=>i.text))).toEqual(['最初请求']);
});
