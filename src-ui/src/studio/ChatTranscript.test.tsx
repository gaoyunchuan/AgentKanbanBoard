import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>{cleanup();vi.useRealTimers()});
import {ChatTranscript} from './ChatTranscript';
import {HistoryImageLoader} from './HistoryMessageImages';
import type {HistoryEvent} from './useConversationHistory';
import type {WorkEvent,WorkRun} from '../workbench/types';
const run:WorkRun={id:'r',task_id:'t',generation:1,prompt:'检查代码',status:'running',started_at:'2026-10-30T10:00:00Z'};
const event=(id:number,item:Record<string,unknown>):WorkEvent=>({id,task_id:'t',run_id:'r',kind:'item/completed',created_at:`2026-10-30T10:00:${String(id).padStart(2,'0')}Z`,payload:{turnId:'turn',item}});
const events=[event(1,{id:'user',type:'userMessage',content:[{text:'检查代码'}]}),event(2,{id:'thinking',type:'agentMessage',phase:'commentary',text:'先核对现有代码。'}),event(3,{id:'cmd-a',type:'commandExecution',command:'cat README.md',commandActions:[{type:'read',name:'README.md'}],aggregatedOutput:'文件内容',status:'completed'}),event(4,{id:'cmd-b',type:'commandExecution',command:'npm test',aggregatedOutput:'测试通过',status:'completed'}),event(5,{id:'final',type:'agentMessage',phase:'final_answer',text:'检查完成。'})];
it('连续工具合并一行，默认隐藏输出，按工具再次展开',async()=>{
 const user=userEvent.setup();render(<ChatTranscript events={events.slice(0,4)} runs={[run]} currentRunId="r"/>);
 const group=screen.getByRole('button',{name:/读取.*文件.*执行.*命令/});expect(group).toHaveAttribute('aria-expanded','false');
 expect(screen.queryByText('文件内容')).not.toBeInTheDocument();
 await user.click(group);const command=screen.getByRole('button',{name:/npm test/});expect(screen.queryByText('测试通过')).not.toBeInTheDocument();
 await user.click(command);expect(screen.getByText('测试通过')).toBeVisible();
});
it('执行中显示过程，结束自动收起，结果在分隔线下独立可见',async()=>{
 const user=userEvent.setup();const view=render(<ChatTranscript events={events.slice(0,4)} runs={[run]} currentRunId="r"/>);
 expect(screen.getByText('先核对现有代码。')).toBeVisible();
 view.rerender(<ChatTranscript events={events} runs={[{...run,status:'completed',ended_at:'2026-10-30T10:02:05Z'}]}/>);
 expect(screen.getByRole('button',{name:/Worked for 2分钟5秒/})).toHaveAttribute('aria-expanded','false');
 expect(screen.queryByText('先核对现有代码。')).not.toBeInTheDocument();expect(screen.getByText('检查完成。')).toBeVisible();
 await user.click(screen.getByRole('button',{name:/Worked for/}));expect(screen.getByText('先核对现有代码。')).toBeVisible();
 expect(within(screen.getByLabelText('最终回答')).getByText('检查完成。')).toBeVisible();
});
it('新轮次不能把上轮结果或工具吸收进自己的过程',()=>{
 const second=events.map(e=>({...e,id:e.id+10,run_id:'r2',payload:{...(e.payload as object),turnId:'turn-2'}}));
 render(<ChatTranscript events={[...events,...second]} runs={[{...run,status:'completed',ended_at:'2026-10-30T10:02:05Z'},{...run,id:'r2'}]} currentRunId="r2"/>);
 expect(screen.getAllByLabelText('最终回答')).toHaveLength(2);
 expect(screen.getByRole('button',{name:/Worked for/})).toHaveAttribute('aria-expanded','false');
 expect(screen.getByRole('button',{name:/Working for/})).toHaveAttribute('aria-expanded','true');
});

const userImage='data:image/png;base64,AA==';
it('同一轮的本地发送与协议回显只显示一次，两次真实发送的同文消息都保留',()=>{
 const text='同步这个分组';
 const local=(id:number):WorkEvent=>({...event(id,{}),kind:'user_message',payload:{text}});
 const echo=(id:number,itemId:string):WorkEvent=>({...event(id,{id:itemId,type:'userMessage',content:[{type:'text',text},{type:'image',url:userImage}]}),payload:{threadId:'main',turnId:'turn',item:{id:itemId,type:'userMessage',content:[{type:'text',text},{type:'image',url:userImage}]}}});
 const first=echo(12,'echo-1');
 const other=echo(15,'echo-2');
 render(<ChatTranscript events={[local(10),{...first,id:11,kind:'item/started'},first,local(13),{...other,id:14,kind:'item/started'},other]} runs={[{...run,thread_id:'main',turn_id:'turn'}]} currentRunId="r"/>);
 expect(screen.getAllByText(text)).toHaveLength(2);
 expect(screen.getAllByRole('img')).toHaveLength(2);
});
it('同一轮内的最终答复出现在下一条用户补充之前，折叠过程后补充仍可见',()=>{
 const followup:WorkEvent={...event(6,{}),kind:'user_message',payload:{text:'后来补充的条件'}};
 const answer=event(7,{id:'second-answer',type:'agentMessage',phase:'final_answer',text:'按补充条件完成。'});
 render(<ChatTranscript events={[...events,followup,answer]} runs={[{...run,status:'completed'}]}/>);
 const first=screen.getByText('检查完成。'),user=screen.getByText('后来补充的条件'),last=screen.getByText('按补充条件完成。');
 expect(first.compareDocumentPosition(user)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(user.compareDocumentPosition(last)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('历史文字与多图、纯图片都可见，重新读取不重复',()=>{
 const messages:WorkEvent[]=[{id:50,task_id:'t',run_id:'r',kind:'user_message',created_at:run.started_at,payload:{text:'历史截图',attachments:[{type:'image',url:userImage},{type:'image',url:userImage}]}},{id:51,task_id:'t',run_id:'r',kind:'user_message',created_at:run.started_at,payload:{text:'',attachments:[{type:'image',url:userImage}]}}];
 const view=render(<ChatTranscript events={messages} runs={[{...run,status:'completed'}]}/>);
 expect(screen.getByText('历史截图')).toBeVisible();expect(screen.getAllByRole('img')).toHaveLength(3);
 view.rerender(<ChatTranscript events={[...messages]} runs={[{...run,status:'completed'}]}/>);
 expect(screen.getAllByRole('img')).toHaveLength(3);
});
it('执行中补充图片留在用户消息位置',()=>{
 const message:WorkEvent={id:60,task_id:'t',run_id:'r',kind:'user_message',created_at:'2026-10-30T10:00:03Z',payload:{text:'中途截图',attachments:[{type:'image',url:userImage}]}};
 render(<ChatTranscript events={[events[0],events[1],message]} runs={[run]} currentRunId="r"/>);
 const process=screen.getByLabelText('执行过程'),messageText=screen.getByText('中途截图');
 expect(process.compareDocumentPosition(messageText)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(screen.getByRole('img',{name:'已发送的图片 1'})).toHaveAttribute('src',userImage);
});
it('坏图片与不支持的图片显示错误，保留其他内容',()=>{
 const message:WorkEvent={id:70,task_id:'t',run_id:'r',kind:'user_message',created_at:run.started_at,payload:{text:'保留文字',attachments:[{type:'image',url:userImage},{type:'image',url:'https://example.com/track.png'}]}};
 render(<ChatTranscript events={[message]} runs={[run]}/>);
 const image=screen.getByRole('img',{name:'已发送的图片 1'});fireEvent.error(image);
 expect(screen.getByText('图片 1 加载失败')).toBeVisible();expect(screen.getByText('有 1 张图片暂不支持显示')).toBeVisible();
 expect(screen.getByText('保留文字')).toBeVisible();expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

const compactionStart=Date.parse('2026-10-30T10:00:00Z');
const compactionEvent=(kind:string,completed=false):WorkEvent=>({...event(1,{id:'compact',type:'contextCompaction',startedAtMs:compactionStart,...(completed?{completedAtMs:compactionStart+164000}:{})}),kind});
it('压缩期间立即显示状态和递增耗时，重复读取不归零',()=>{
 vi.useFakeTimers();vi.setSystemTime(compactionStart+2000);
 const list=[compactionEvent('item/started')];const view=render(<ChatTranscript events={list} runs={[run]} currentRunId="r"/>);
 expect(screen.getByRole('status')).toHaveTextContent('正在压缩上下文');expect(screen.getByRole('timer')).toHaveTextContent('已用时 2秒');
 act(()=>vi.advanceTimersByTime(3000));expect(screen.getByRole('timer')).toHaveTextContent('已用时 5秒');
 view.rerender(<ChatTranscript events={[...list]} runs={[run]} currentRunId="r"/>);expect(screen.getByRole('timer')).toHaveTextContent('已用时 5秒');
 view.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('压缩完成保留准确耗时，不影响同轮后续执行',()=>{
 vi.useFakeTimers();vi.setSystemTime(compactionStart+170000);
 const list=[compactionEvent('item/started'),compactionEvent('item/completed',true)];
 render(<ChatTranscript events={list} runs={[run]} currentRunId="r"/>);
 expect(screen.getByRole('status')).toHaveTextContent('上下文压缩完成');expect(screen.getByRole('timer')).toHaveTextContent('耗时 2分钟44秒');
 act(()=>vi.advanceTimersByTime(5000));expect(screen.getByRole('timer')).toHaveTextContent('耗时 2分钟44秒');
 expect(screen.queryByText('正在压缩上下文')).not.toBeInTheDocument();
});
it('执行中断后停止压缩计时，不误报压缩成功',()=>{
 vi.useFakeTimers();vi.setSystemTime(compactionStart+20000);
 render(<ChatTranscript events={[compactionEvent('item/started')]} runs={[{...run,status:'interrupted',ended_at:'2026-10-30T10:00:10Z'}]}/>);
 fireEvent.click(screen.getByRole('button',{name:/Worked for/}));
 expect(screen.getByRole('status')).toHaveTextContent('上下文压缩已结束');expect(screen.getByRole('timer')).toHaveTextContent('耗时 10秒');
 act(()=>vi.advanceTimersByTime(5000));expect(screen.getByRole('timer')).toHaveTextContent('耗时 10秒');expect(vi.getTimerCount()).toBe(0);
});
it('子 Agent 已结束而主执行继续时，子压缩也停止计时',()=>{
 vi.useFakeTimers();vi.setSystemTime(compactionStart+20000);
 const child:WorkEvent={...compactionEvent('item/started'),id:81,payload:{threadId:'child',turnId:'child-turn',item:{id:'child-compact',type:'contextCompaction',startedAtMs:compactionStart}}};
 const root:WorkEvent={...event(80,{id:'root',type:'agentMessage',phase:'commentary',text:'主会话继续'}),payload:{threadId:'main',turnId:'main-turn',item:{id:'root',type:'agentMessage',phase:'commentary',text:'主会话继续'}}};
 const stop:WorkEvent={...child,id:82,kind:'turn/completed',created_at:'2026-10-30T10:00:10Z',payload:{threadId:'child',turn:{id:'child-turn',status:'interrupted'}}};
 render(<ChatTranscript events={[root,child,stop]} runs={[{...run,thread_id:'main',turn_id:'main-turn'}]} currentRunId="r"/>);
 fireEvent.click(screen.getByRole('button',{name:'智能体 1 次'}));fireEvent.click(screen.getByRole('button',{name:'智能体 child'}));
 expect(screen.getByRole('status')).toHaveTextContent('上下文压缩已结束');expect(screen.getByRole('timer')).toHaveTextContent('耗时 10秒');
 act(()=>vi.advanceTimersByTime(5000));expect(screen.getByRole('timer')).toHaveTextContent('耗时 10秒');
});

it('历史生成图片位于对应的最终答复下，执行过程保持收起',async()=>{
 const image:HistoryEvent={...event(4,{}),truncated:true,payload:{item_type:'imageGeneration',
   item_id:'generated',turnId:'turn',image_slots:[0]}};
 const load=vi.fn().mockResolvedValue(userImage);
 const finished={...run,status:'completed'};
 render(<HistoryImageLoader.Provider value={load}>
  <ChatTranscript events={[...events.slice(0,3),image,events[4]]} runs={[finished]}/>
 </HistoryImageLoader.Provider>);
 expect(screen.getByRole('button',{name:/Worked for/})).toHaveAttribute('aria-expanded','false');
 const generated=await screen.findByRole('img',{name:'生成的图片 1'});
 expect(generated).toHaveAttribute('src',userImage);
 expect(screen.getByText('检查完成。').compareDocumentPosition(generated)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(load).toHaveBeenCalledExactlyOnceWith({eventId:4,slot:0});
});
