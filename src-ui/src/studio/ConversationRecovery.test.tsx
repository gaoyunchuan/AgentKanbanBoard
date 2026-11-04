import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,within,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import {createDemoApi} from './demo';
import type {Workspace} from './model';
import type {StudioApi} from './api';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks()});

async function setup(fail=false){
 const base=createDemoApi(),data=await base.call<Workspace>('snapshot');
 const target=data.conversations[0];let attempts=0;
 const api={...base,call:vi.fn(async<T,>(method:string,p:Record<string,unknown>={})=>{
  if(method==='recover_connection'&&fail&&attempts++===0)throw new Error('会话仍被 Codex 占用，请先手动归档');
  return base.call<T>(method,p);
 })};
 const user=userEvent.setup();render(<ChatApp api={{...api,call:api.call as StudioApi['call']}}/>);await screen.findByText('隔离演示 · 不调用模型');
 await user.click(document.querySelector('[data-task-row="diff"] .task-title-btn')!);
 await screen.findByRole('textbox',{name:'聊天输入'});
 await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'保留未发送草稿');
 await user.click(screen.getByRole('button',{name:'切换本任务会话'}));
 await user.click(screen.getByRole('button',{name:`${target.title} 会话菜单`}));
 return {api,user,target};
}

describe('半自动恢复会话连接',()=>{
 it('冻结非当前目标，取消不恢复，不调用原生接口或发送消息',async()=>{
  const {api,user,target}=await setup();
  await user.click(screen.getByRole('button',{name:'恢复会话连接'}));
  const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(target.title)).toBeVisible();
  await user.click(within(dialog).getByRole('button',{name:'打开 Codex 中的原会话'}));
  expect(invoke).not.toHaveBeenCalled();
  expect(api.call).toHaveBeenCalledWith('open_recovery_thread',expect.objectContaining({conversation_id:target.id,thread_id:target.thread_id,revision:target.revision}));
  await user.click(within(dialog).getByRole('button',{name:'取消'}));
  expect(api.call.mock.calls.some(([m])=>m==='recover_connection'||m==='send')).toBe(false);
  expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('保留未发送草稿');
 });
 it('未释放写锁时可重试，成功保留原会话和草稿，不发送业务消息',async()=>{
  const {api,user,target}=await setup(true);
  await user.click(screen.getByRole('button',{name:'恢复会话连接'}));
  await user.click(screen.getByRole('checkbox',{name:'我已核对执行结束，并在 Codex 中归档了这条会话'}));
  await user.click(screen.getByRole('button',{name:'已归档，恢复连接'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('请先手动归档');
  await user.click(screen.getByRole('button',{name:'已归档，恢复连接'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const calls=api.call.mock.calls.filter(([m])=>m==='recover_connection');expect(calls).toHaveLength(2);
  expect(calls[1][1]).toEqual({conversation_id:target.id,thread_id:target.thread_id,revision:target.revision});
  expect(api.call.mock.calls.some(([m])=>m==='send')).toBe(false);
  expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('保留未发送草稿');
 });
});
