import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import { createDemoApi } from './demo';
import type { Workspace } from './model';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async (command:string)=>{
  if(command==='workbench_rpc')return {data:[{model:'test-model-a',displayName:'测试模型 A'},{model:'test-model-b',displayName:'测试模型 B'}]};
  throw new Error(`不应调用原生接口：${command}`);
})}));
afterEach(()=>{cleanup();localStorage.clear()});

async function setup(failConfig=false,running=false,beforeConfig?:()=>Promise<void>){
  const base=createDemoApi();
  const calls:{method:string;params?:Record<string,unknown>}[]=[];
  const api={...base,native:true,call:async<T,>(method:string,params?:Record<string,unknown>):Promise<T>=>{
    calls.push({method,params});
    if(method==='update_conversation'&&beforeConfig)await beforeConfig();
    if(failConfig&&method==='update_conversation'){failConfig=false;throw new Error('模拟模型设置保存失败');}
    const result=await base.call<T>(method,params);
    if(running&&method==='snapshot'){const data=result as Workspace;data.conversations[0]={...data.conversations[0],runtime_status:'running',current_run_id:'test-run'};}
    return result;
  }};
  const user=userEvent.setup();
  render(<ChatApp api={api}/>);
  await screen.findByRole('region',{name:'全局任务树'});
  await user.click(screen.getByRole('button',{name:'新聊天'}));
  return {api,base,calls,user};
}
async function setModel(user:ReturnType<typeof userEvent.setup>,model='测试模型 A',effort='high'){
  await user.click(document.querySelector('.model-btn')!);
  const dialog=screen.getByRole('dialog',{name:'模型与推理强度'});
  await user.click(within(dialog).getByRole('combobox',{name:'可用模型'}));
  await user.click(await screen.findByRole('option',{name:model}));
  await user.click(within(dialog).getByRole('combobox',{name:'推理强度'}));
  await user.click(await screen.findByRole('option',{name:effort}));
  expect(within(dialog).getByRole('button',{name:'保存会话设置'})).toBeEnabled();
  await user.click(within(dialog).getByRole('button',{name:'保存会话设置'}));
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'模型与推理强度'})).not.toBeInTheDocument());
}
async function send(user:ReturnType<typeof userEvent.setup>){
  await user.click(screen.getByRole('button',{name:'选择项目'}));
  await user.click(screen.getByRole('option',{name:'release-console'}));
  await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'使用选定模型开始');
  await user.click(screen.getByRole('button',{name:'发送消息'}));
}

describe('新会话的草稿模型设置',()=>{
  it('发送前可保存、重开并取消编辑，切换已有会话后草稿配置仍保留',async()=>{
    const {base,user}=await setup();
    const before=await base.call<Workspace>('snapshot');
    await setModel(user);
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
    expect((await base.call<Workspace>('snapshot')).conversations).toHaveLength(before.conversations.length);
    await user.click(document.querySelector('.model-btn')!);
    expect(screen.getByRole('combobox',{name:'可用模型'})).toHaveTextContent('测试模型 A');
    expect(screen.getByRole('combobox',{name:'推理强度'})).toHaveTextContent('high');
    await user.click(screen.getByRole('button',{name:'取消'}));
    await user.click(screen.getByRole('button',{name:'会话'}));
    await user.click(await screen.findByRole('button',{name:'实现部署前 Diff'}));
    expect(document.querySelector('.model-btn')).not.toHaveTextContent('test-model-a');
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
  });

  it('从任务页进入新聊天后，轮询刷新不能自动选回任务并替换模型草稿',async()=>{
    const {calls,user}=await setup();
    await setModel(user);
    const count=calls.filter(c=>c.method==='snapshot').length;
    await waitFor(()=>expect(calls.filter(c=>c.method==='snapshot').length).toBeGreaterThan(count),{timeout:4000});
    expect(screen.getByRole('heading',{name:'新会话'})).toBeInTheDocument();
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
  });

  it('首次发送先持久化模型配置，再执行消息，新会话不继承已发送草稿的选择',async()=>{
    const {base,calls,user}=await setup();
    await setModel(user);
    await send(user);
    await waitFor(()=>expect(calls.some(c=>c.method==='send')).toBe(true));
    const saved=calls.find(c=>c.method==='update_conversation')!;
    expect(saved.params?.patch).toEqual({model:'test-model-a',reasoning_effort:'high'});
    expect(calls.indexOf(saved)).toBeLessThan(calls.findIndex(c=>c.method==='send'));
    const snapshot=await base.call<Workspace>('snapshot');
    const conversation=snapshot.conversations.find(c=>c.id===saved.params?.conversation_id)!;
    expect(conversation.config).toMatchObject({model:'test-model-a',reasoning_effort:'high'});
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(document.querySelector('.model-btn')).toHaveTextContent('Codex 默认模型');
  });

  it('已有空闲会话仍可改模型，并与新会话草稿隔离',async()=>{
    const {base,user}=await setup();
    await user.click(screen.getByRole('button',{name:'会话'}));
    await user.click(await screen.findByRole('button',{name:'实现部署前 Diff'}));
    await setModel(user,'测试模型 B','medium');
    const snapshot=await base.call<Workspace>('snapshot');
    expect(snapshot.conversations[0].config).toMatchObject({model:'test-model-b',reasoning_effort:'medium'});
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(document.querySelector('.model-btn')).toHaveTextContent('Codex 默认模型');
  });

  it('任务尚无会话时也可配置模型，不改其他任务的草稿',async()=>{
    const {base,user}=await setup();
    await user.click(screen.getByRole('button',{name:'任务'}));
    await user.click(document.querySelector('[data-task-row="review"] .task-title-btn')!);
    await screen.findByRole('textbox',{name:'聊天输入'});
    const before=await base.call<Workspace>('snapshot');
    await setModel(user);
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(document.querySelector('.model-btn')).toHaveTextContent('Codex 默认模型');
    await user.click(screen.getByRole('button',{name:'任务'}));
    await user.click(document.querySelector('[data-task-row="review"] .task-title-btn')!);
    await screen.findByRole('textbox',{name:'聊天输入'});
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
    expect((await base.call<Workspace>('snapshot')).conversations).toHaveLength(before.conversations.length);
  });

  it('运行中的已有会话仍要求先停止，不能直接保存模型',async()=>{
    const {calls,user}=await setup(false,true);
    await user.click(screen.getByRole('button',{name:'会话'}));
    await user.click(await screen.findByRole('button',{name:'实现部署前 Diff'}));
    await user.click(document.querySelector('.model-btn')!);
    expect(screen.getByRole('button',{name:'保存会话设置'})).toBeDisabled();
    expect(calls.some(c=>c.method==='update_conversation')).toBe(false);
  });

  it('新会话可恢复模型默认值，首次发送不遗留之前的选择',async()=>{
    const {calls,user}=await setup();
    await setModel(user);
    await setModel(user,'Codex 默认模型','模型默认');
    expect(document.querySelector('.model-btn')).toHaveTextContent('Codex 默认模型');
    expect(document.querySelector('.model-btn')).not.toHaveTextContent('high');
    await send(user);
    await waitFor(()=>expect(calls.some(c=>c.method==='send')).toBe(true));
    expect(calls.find(c=>c.method==='update_conversation')?.params?.patch).toEqual({model:null,reasoning_effort:null});
  });

  it('配置保存失败后重试成功，不在新聊天中恢复已发送的草稿和模型',async()=>{
    const {calls,user}=await setup(true);
    await setModel(user);
    await send(user);
    await screen.findByText(/模拟模型设置保存失败/);
    await user.click(screen.getByRole('button',{name:'发送消息'}));
    await waitFor(()=>expect(calls.some(c=>c.method==='send')).toBe(true));
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('');
    expect(document.querySelector('.model-btn')).toHaveTextContent('Codex 默认模型');
  });

  it('首次配置保存等待期间输入的新内容不会被失败快照覆盖',async()=>{
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve});
    const {calls,user}=await setup(true,false,()=>gate);
    await setModel(user);
    await send(user);
    await waitFor(()=>expect(calls.some(c=>c.method==='update_conversation')).toBe(true));
    const input=screen.getByRole('textbox',{name:'聊天输入'});
    await waitFor(()=>expect(input).toHaveValue(''));
    await user.type(input,'会话中的后续输入');
    release();
    await screen.findByText(/模拟模型设置保存失败/);
    expect(input).toHaveValue('会话中的后续输入');
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
    await user.click(screen.getByRole('button',{name:'发送消息'}));
    await waitFor(()=>expect(calls.some(c=>c.method==='send')).toBe(true));
    const updates=calls.filter(c=>c.method==='update_conversation');
    expect(updates).toHaveLength(2);
    expect(updates[1].params?.patch).toEqual({model:'test-model-a',reasoning_effort:'high'});
    expect(calls.find(c=>c.method==='send')?.params?.text).toBe('会话中的后续输入');
    await user.click(screen.getByRole('button',{name:'新聊天'}));
    expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('使用选定模型开始');
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
  });

  it('持久化模型配置失败时保留草稿，不按默认模型执行消息',async()=>{
    const {calls,user}=await setup(true);
    await setModel(user);
    await send(user);
    await screen.findByText(/模拟模型设置保存失败/);
    expect(calls.some(c=>c.method==='send')).toBe(false);
    expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('使用选定模型开始');
    expect(document.querySelector('.model-btn')).toHaveTextContent('test-model-a · high');
  });
});
