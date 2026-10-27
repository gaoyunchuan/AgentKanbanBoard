import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BrowserPane } from './BrowserPane';
import { StudioContext, type StudioState } from './context';
import { defaultConfig, type Conversation } from './model';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
const conversation:Conversation={id:'c',task_id:'t',title:'test',mode:'manual',project_id:'p',config:defaultConfig('/tmp'),runtime_status:'idle',pinned:false,closed:false,revision:0,created_at:'',updated_at:''};
function fixture(){
 let pages=[{id:'one',title:'First page',url:'about:blank'}],target='one';
 vi.mocked(invoke).mockImplementation(async(_name,args)=>{
  const value=args as {method:string;params:{target_id?:string}};
  if(value.method==='new_page'){pages.push({id:'two',title:'Second page',url:'about:blank'});target='two';return {target_id:target};}
  if(value.method==='close_page'){pages=pages.filter(p=>p.id!==value.params.target_id);target=pages[0].id;return {target_id:target};}
  if(value.method==='activate_page')target=value.params.target_id!;
  if(value.method==='frame')return {data:'AA==',width:600,height:500,target_id:value.params.target_id||target,title:'page',url:'about:blank',pages};
  return {pages};
 });
 const state={api:{native:true},conversation,command:vi.fn(async()=>{}),newConversation:vi.fn()} as unknown as StudioState;
 return state;
}
describe('owned browser tabs',()=>{
 it('creates, selects and closes real target IDs through the native bridge',async()=>{
  const state=fixture(),user=userEvent.setup();render(<StudioContext.Provider value={state}><BrowserPane/></StudioContext.Provider>);
  await user.click(screen.getByRole('button',{name:'打开侧边浏览器'}));await screen.findByRole('tab',{name:'First page'});
  await user.click(screen.getByRole('button',{name:'新建浏览器标签'}));await screen.findByRole('tab',{name:'Second page'});
  await user.click(screen.getByRole('tab',{name:'First page'}));
  expect(invoke).toHaveBeenCalledWith('chat_browser',expect.objectContaining({conversationId:'c',method:'activate_page',params:expect.objectContaining({target_id:'one'})}));
  await user.click(screen.getByRole('button',{name:'关闭网页 Second page'}));
  expect(invoke).toHaveBeenCalledWith('chat_browser',expect.objectContaining({method:'close_page',params:expect.objectContaining({target_id:'two'})}));
  await waitFor(()=>expect(screen.queryByRole('tab',{name:'Second page'})).not.toBeInTheDocument(),{timeout:2000});
 });
 it('keeps the native owner when the selected task changes during an operation',async()=>{
  const state=fixture(),user=userEvent.setup();const {rerender}=render(<StudioContext.Provider value={state}><BrowserPane/></StudioContext.Provider>);
  await user.click(screen.getByRole('button',{name:'打开侧边浏览器'}));await screen.findByRole('tab',{name:'First page'});
  let finish:(value:unknown)=>void=()=>{};
  vi.mocked(invoke).mockImplementation(async(_name,args)=>{if((args as {method:string}).method==='new_page')return new Promise(resolve=>{finish=resolve});return {};});
  fireEvent.click(screen.getByRole('button',{name:'新建浏览器标签'}));
  rerender(<StudioContext.Provider value={{...state,conversation:{...conversation,id:'other'}}}><BrowserPane/></StudioContext.Provider>);
  finish({target_id:'old-task-page'});
  expect(await screen.findByRole('button',{name:'打开侧边浏览器'})).toBeInTheDocument();
  expect(screen.queryByRole('tab',{name:'First page'})).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith('chat_browser',expect.objectContaining({conversationId:'other',method:'new_page'}));
 });
});
