import {expect,test} from 'vitest';
import {createDemoApi} from './demo';
import {preferredConversation,sidebarTasks,type Workspace} from './model';

test('侧栏按多会话最大活动排序，平局稳定且不改变任务树位置',async()=>{
 const api=createDemoApi();const d=await api.call<Workspace>('snapshot');
 const extra=await api.call<any>('create_conversation',{task_id:'review'});
 d.conversations.push(extra);d.conversations.forEach((c,i)=>Object.assign(c,{activity_at:`2026-11-01T00:00:0${i}Z`}));
 const before=d.tasks.map(t=>t.position);
 expect(sidebarTasks(d).map(t=>t.id).slice(0,2)).toEqual(['review','regression']);
 expect(d.tasks.map(t=>t.position)).toEqual(before);
 const task=d.tasks.find(t=>t.id==='diff')!;const choices=d.conversations.filter(c=>c.task_id===task.id);
 Object.assign(choices[0],{unread:true,activity_at:'2026-11-03T00:00:00Z'});
 expect(preferredConversation(d,task)?.id).toBe(choices[0].id);
});

test('已有消息的任务不会因为新建空会话排到更近消息之前',async()=>{
 const api=createDemoApi(),data=await api.call<Workspace>('snapshot');
 const a=data.tasks.find(t=>t.id==='diff')!,b=data.tasks.find(t=>t.id==='contract')!;
 data.tasks=[a,b];data.conversations=data.conversations.filter(c=>c.task_id===a.id||c.task_id===b.id);
 for(const c of data.conversations)Object.assign(c,{created_at:'2026-11-01T00:00:00Z',activity_at:c.task_id===a.id?'2026-11-01T10:00:00Z':'2026-11-02T10:00:00Z'});
 const blank={...data.conversations[0],id:'empty-new',activity_at:null,created_at:'2026-11-04T10:00:00Z'};
 data.conversations.push(blank);
 expect(sidebarTasks(data).map(t=>t.id)).toEqual([b.id,a.id]);
});
