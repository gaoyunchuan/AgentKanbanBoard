import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,within,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import {createDemoApi} from './demo';
import type {Workspace} from './model';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.reject('禁止调用真实模型'))}));
afterEach(()=>{cleanup();localStorage.clear()});
async function setup(){const api=createDemoApi(),user=userEvent.setup();const data=await api.call<Workspace>('snapshot');render(<ChatApp api={api}/>);await screen.findByText('隔离演示 · 不调用模型');const row=document.querySelector('[data-task-row="diff"]')!;await user.click(row.querySelector('.task-title-btn')!);await screen.findByRole('textbox',{name:'聊天输入'});return {api,user,data};}
async function deletionMenu(user:ReturnType<typeof userEvent.setup>,title:string){await user.click(await screen.findByRole('button',{name:'切换本任务会话'}));await user.click(screen.getByRole('button',{name:`${title} 会话菜单`}));}
describe('人工会话删除与恢复',()=>{
 it('非当前会话菜单不切换选择，取消不删除，确认后可从已删除恢复历史',async()=>{
  const {api,user,data}=await setup();const current=data.conversations[1],target=data.conversations[0];
  await deletionMenu(user,target.title);await user.click(screen.getByRole('button',{name:'删除会话'}));
  const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(`「${target.title}」`)).toBeVisible();
  expect(screen.getByRole('tab',{name:current.title,selected:true})).toBeVisible();
  await user.click(within(dialog).getByRole('button',{name:'取消'}));expect((await api.call<Workspace>('snapshot')).conversations.some(x=>x.id===target.id)).toBe(true);
  await deletionMenu(user,target.title);await user.click(screen.getByRole('button',{name:'删除会话'}));await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'移入已删除'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());expect(screen.getByRole('tab',{name:current.title,selected:true})).toBeVisible();
  expect((await api.call<Workspace>('snapshot')).conversations.some(x=>x.id===target.id)).toBe(false);
  await user.click(screen.getByRole('button',{name:'任务'}));await user.click(screen.getByRole('button',{name:'已删除'}));
  const deleted=screen.getByRole('dialog');expect(within(deleted).getByText(target.title)).toBeVisible();await user.click(within(deleted).getByRole('button',{name:`恢复会话 ${target.title}`}));
  await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).conversations.some(x=>x.id===target.id)).toBe(true));
  expect((await api.call<{events:unknown[]}>('detail',{conversation_id:target.id})).events).toHaveLength(2);
 });
 it('删除当前会话后切换同任务会话，删除最后会话则回到任务详情，不自动创建',async()=>{
  const {api,user,data}=await setup();
  for(const target of [data.conversations[1],data.conversations[0]]){
   await deletionMenu(user,target.title);await user.click(screen.getByRole('button',{name:'删除会话'}));await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'移入已删除'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  }
  expect(screen.getByRole('region',{name:'全局任务树'})).toBeVisible();expect(screen.getByLabelText('任务属性区域')).toBeVisible();
  expect((await api.call<Workspace>('snapshot')).conversations.filter(x=>x.task_id==='diff')).toHaveLength(0);
 });
 it('侧栏删除入口一致，恢复后保留当前会话的未发送草稿',async()=>{
  const {user,data}=await setup();const target=data.conversations[1];
  await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'这段草稿不能丢');
  await user.click(screen.getByRole('button',{name:'会话'}));
  await user.click(screen.getByRole('button',{name:`${target.title} 会话菜单`}));
  await user.click(screen.getByRole('button',{name:'删除会话'}));await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'移入已删除'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('tab',{name:data.conversations[0].title,selected:true})).toBeVisible();
  await user.click(screen.getByRole('button',{name:'任务'}));await user.click(screen.getByRole('button',{name:'已删除'}));
  await user.click(await screen.findByRole('button',{name:`恢复会话 ${target.title}`}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:`恢复会话 ${target.title}`})).not.toBeInTheDocument());
  await user.click(within(screen.getByRole('dialog')).getByRole('button',{name:'关闭'}));
  await user.click(within(document.querySelector('[data-task-row="diff"] .sessions-cell')!).getByRole('button',{name:target.title}));
  expect(await screen.findByRole('textbox',{name:'聊天输入'})).toHaveValue('这段草稿不能丢');
 });
 it('排队或正在提取结果的会话不可删除，失败时保持会话可见',async()=>{
  const api=createDemoApi();const snapshot=await api.call<Workspace>('snapshot');const target=snapshot.conversations[1];
  const guarded={...api,call:async<T,>(method:string,p:Record<string,unknown>={})=>{const value=await api.call<T>(method,p);if(method==='snapshot'){const data=value as Workspace;data.conversations.find(c=>c.id===target.id)!.runtime_status='queued';}return value;}};
  const user=userEvent.setup();render(<ChatApp api={guarded}/>);await screen.findByText('隔离演示 · 不调用模型');await user.click(document.querySelector('[data-task-row="diff"] .session-chip')!);
  await deletionMenu(user,target.title);expect(screen.getByRole('button',{name:'删除会话'})).toBeDisabled();expect(screen.getByText('请先停止会话执行或结果提取，并确认资源已释放')).toBeVisible();
 });
 it('自动主会话菜单说明禁止删除的原因',async()=>{
  const {user,data}=await setup();await user.click(screen.getByRole('button',{name:'任务'}));await user.click(document.querySelector('[data-task-row="contract"] .task-title-btn')!);
  await deletionMenu(user,data.conversations.find(x=>x.task_id==='contract')!.title);
  expect(screen.getByRole('button',{name:'删除会话'})).toBeDisabled();expect(screen.getByText('自动主会话保留任务执行历史，不能删除')).toBeVisible();
 });
});
