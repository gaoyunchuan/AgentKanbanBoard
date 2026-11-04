import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import {createDemoApi} from './demo';
import type {StudioApi} from './api';
import type {Workspace} from './model';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.reject('演示不能调用原生接口'))}));
afterEach(()=>{cleanup();localStorage.clear()});
const thread='550e8400-e29b-41d4-a716-446655440010';
const candidate={id:thread,name:'Codex 中的迁移方案',cwd:'/demo/runtime-api-server',updated_at:1793750400,status:'idle',archived:false};

async function setup(intercept?:(method:string,p:Record<string,unknown>)=>unknown){
 const base=createDemoApi();
 const calls:{method:string;p:Record<string,unknown>}[]=[];
 const api:StudioApi={...base,call:async<T,>(method:string,p:Record<string,unknown>={})=>{
  calls.push({method,p});
  const value=intercept?.(method,p);if(value!==undefined)return await value as T;
  if(method==='codex_threads')return {data:[candidate],nextCursor:null} as T;
  return base.call<T>(method,p);
 }};
 const user=userEvent.setup();render(<ChatApp api={api}/>);
 await screen.findByText('隔离演示 · 不调用模型');
 return {base,api,user,calls};
}
async function bindMenu(){
 fireEvent.contextMenu(document.querySelector('[data-task-row="review"]')!,{clientX:500,clientY:300});
 fireEvent.click(await screen.findByRole('menuitem',{name:'绑定 Codex 会话'}));
 return screen.findByRole('dialog');
}
async function bind(user:ReturnType<typeof userEvent.setup>){
 const dialog=await bindMenu();await user.click(await within(dialog).findByRole('button',{name:/Codex 中的迁移方案/}));
 await user.click(within(dialog).getByRole('button',{name:'绑定并查看历史'}));
 await screen.findByText('等待会话交接');
}

describe('Codex 会话绑定与交接',()=>{
 it('绑定右键目标，保留原 Thread，展示历史并阻止提前发送',async()=>{
  const {base,user,calls}=await setup();await bind(user);
  const data=await base.call<Workspace>('snapshot');
  const c=data.conversations.find(c=>c.thread_id===thread)!;
  expect(c.task_id).toBe('review');expect(c.config.workspace).toBe('/demo/runtime-api-server');
  expect(await screen.findByText('Codex 中已有的原始问题')).toBeVisible();
  await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'待交接草稿');
  expect(screen.getByRole('button',{name:'发送消息'})).toBeDisabled();
  expect(calls.some(c=>c.method==='send'||c.method==='recover_connection')).toBe(false);
  await user.click(screen.getByRole('button',{name:'归档交接并接续'}));
  await user.click(screen.getByRole('checkbox',{name:'我已核对执行结束，并在 Codex 中归档了这条会话'}));
  await user.click(screen.getByRole('button',{name:'已归档，恢复连接'}));
  await waitFor(()=>expect(screen.queryByText('等待会话交接')).not.toBeInTheDocument());
  expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('待交接草稿');
  expect(screen.getByRole('button',{name:'发送消息'})).toBeEnabled();
  expect(calls.some(c=>c.method==='send')).toBe(false);
 });

 it('列表失败可重试，搜索与归档条件改变时重置分页',async()=>{
  let failed=false;
  const {user,calls}=await setup((method,p)=>{
   if(method!=='codex_threads')return;
   if(!failed){failed=true;return Promise.reject(new Error('读取列表失败'))}
   return {data:[candidate],nextCursor:p.cursor?null:'older'};
  });
  const dialog=await bindMenu();expect(await within(dialog).findByRole('alert')).toHaveTextContent('读取列表失败');
  await user.click(within(dialog).getByRole('button',{name:'重试'}));
  await user.click(await within(dialog).findByRole('button',{name:'下一页'}));
  await waitFor(()=>expect(calls.some(c=>c.method==='codex_threads'&&c.p.cursor==='older')).toBe(true));
  await user.type(within(dialog).getByRole('textbox',{name:'搜索 Codex 会话'}),'迁移');
  await user.click(within(dialog).getByRole('button',{name:'搜索'}));
  await waitFor(()=>expect(calls.filter(c=>c.method==='codex_threads').slice(-1)[0]?.p).toEqual({query:'迁移',archived:false,cursor:null}));
  await user.click(within(dialog).getByRole('button',{name:'已归档'}));
  await waitFor(()=>expect(calls.filter(c=>c.method==='codex_threads').slice(-1)[0]?.p).toEqual({query:'迁移',archived:true,cursor:null}));
 });

 it('重复绑定定位原记录，跨任务不能覆盖归属',async()=>{
  const {base,user}=await setup();await bind(user);
  await user.click(screen.getByRole('button',{name:'任务'}));
  const dialog=await bindMenu();
  const existing=await within(dialog).findByRole('button',{name:/已绑定当前任务/});await user.click(existing);
  await user.click(within(dialog).getByRole('button',{name:'打开已有会话'}));
  expect((await base.call<Workspace>('snapshot')).conversations.filter(c=>c.thread_id===thread)).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'任务'}));
  fireEvent.contextMenu(document.querySelector('[data-task-row="diff"]')!,{clientX:500,clientY:300});
  await user.click(screen.getByRole('menuitem',{name:'绑定 Codex 会话'}));
  expect(await screen.findByRole('button',{name:/Codex 中的迁移方案.*已绑定「整理本机运行说明」/})).toBeDisabled();
 });

 it('历史分页去重，刷新失败保留已读内容且可重试',async()=>{
  let refreshFailure=false,requests=0;
  const {user}=await setup((method,p)=>{
   if(method!=='codex_history')return;
   requests++;
   if(refreshFailure)return Promise.reject(new Error('读取历史失败'));
   return p.cursor?{data:[{id:'old',turn_id:'t1',kind:'userMessage',text:'更早的问题'},{id:'answer',turn_id:'t1',kind:'agentMessage',text:'原回答'}],nextCursor:null}:{data:[{id:'answer',turn_id:'t1',kind:'agentMessage',text:'原回答'}],nextCursor:'older'};
  });
  await bind(user);await screen.findByText('原回答');
  await user.click(screen.getByRole('button',{name:'加载更早历史'}));
  expect(await screen.findByText('更早的问题')).toBeVisible();expect(screen.getAllByText('原回答')).toHaveLength(1);
  refreshFailure=true;await user.click(screen.getByRole('button',{name:'刷新 Codex 历史'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取历史失败');expect(screen.getByText('更早的问题')).toBeVisible();
  refreshFailure=false;await user.click(screen.getByRole('button',{name:'重试读取历史'}));
  await waitFor(()=>expect(screen.queryByRole('alert')).not.toBeInTheDocument());expect(requests).toBeGreaterThanOrEqual(4);
 });

 it('列表旧响应不能覆盖新归档范围',async()=>{
  let resolveOld!:(value:unknown)=>void;
  const {user}=await setup((method,p)=>{
   if(method!=='codex_threads')return;
   if(!p.archived)return new Promise(resolve=>{resolveOld=resolve});
   return {data:[{...candidate,name:'已归档方案'}],nextCursor:null};
  });
  const dialog=await bindMenu();await user.click(within(dialog).getByRole('button',{name:'已归档'}));
  await within(dialog).findByRole('button',{name:/已归档方案/});
  await act(async()=>{resolveOld({data:[candidate],nextCursor:null})});
  expect(within(dialog).getByRole('button',{name:/已归档方案/})).toBeVisible();
  expect(within(dialog).queryByRole('button',{name:/Codex 中的迁移方案/})).not.toBeInTheDocument();
 });

 it('切换会话后丢弃迟到历史，不污染其他会话',async()=>{
  let resolveOld!:(value:unknown)=>void;
  const {user}=await setup(method=>method==='codex_history'?new Promise(resolve=>{resolveOld=resolve}):undefined);
  await bind(user);await user.click(screen.getByRole('button',{name:'任务'}));
  await user.click(document.querySelector('[data-task-row="diff"] .task-title-btn')!);
  await screen.findByRole('textbox',{name:'聊天输入'});
  await act(async()=>{resolveOld({data:[{id:'old',turn_id:'old',kind:'agentMessage',text:'不应串入的新历史'}],nextCursor:null})});
  expect(screen.queryByText('不应串入的新历史')).not.toBeInTheDocument();
  expect(screen.queryByRole('region',{name:'Codex 原会话历史'})).not.toBeInTheDocument();
 });

 it('连续被过滤的本地历史页不耗尽原历史的展示容量',async()=>{
  const {user}=await setup((method,p)=>{
   if(method!=='codex_history')return;
   const n=Number(p.cursor||0);
   return n<21?{data:[],nextCursor:String(n+1)}:{data:[{id:'original',turn_id:'old',kind:'agentMessage',text:'仍可到达的原始成果'}],nextCursor:null};
  });
  await bind(user);
  for(let i=0;i<21;i++){
   const more=await screen.findByRole('button',{name:'加载更早历史'});
   await waitFor(()=>expect(more).toBeEnabled());await user.click(more);
  }
  expect(await screen.findByText('仍可到达的原始成果')).toBeVisible();
 });
});
