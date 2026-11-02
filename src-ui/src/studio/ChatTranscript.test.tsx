import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it} from 'vitest';
afterEach(cleanup);
import {ChatTranscript} from './ChatTranscript';
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
