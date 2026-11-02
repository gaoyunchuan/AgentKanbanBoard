import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import { createDemoApi } from './demo';
import { Markdown } from './components';
import type { Workspace } from './model';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.reject('preview must not invoke Tauri'))}));
afterEach(()=>{cleanup();localStorage.clear()});
async function tasksPage(){const api=createDemoApi(),user=userEvent.setup();render(<ChatApp api={api}/>);await screen.findByText('隔离演示 · 不调用模型');await user.click(screen.getByRole('button',{name:'任务'}));await screen.findByRole('region',{name:'全局任务树'});return {api,user};}
const row=(id:string)=>document.querySelector(`[data-task-row="${id}"]`) as HTMLElement;
const tree=()=>screen.getByRole('region',{name:'全局任务树'});
async function chooseOption(user:ReturnType<typeof userEvent.setup>,trigger:HTMLElement,label:string){
  await user.click(trigger);await user.click(await screen.findByRole('option',{name:label}));
}
describe('task-focused workspace',()=>{
 it('enables the right workspace only in conversations and restores it after leaving the task tree',async()=>{
   const {user}=await tasksPage();
   expect(screen.queryByRole('toolbar',{name:'右侧工具操作'})).not.toBeInTheDocument();
   expect(screen.queryByRole('button',{name:'文件'})).not.toBeInTheDocument();
   expect(screen.getByLabelText('右侧工作区')).not.toBeVisible();
   expect(screen.getByLabelText('任务属性区域')).toBeVisible();
   fireEvent(window,new CustomEvent('akb:open-link',{detail:'README.md'}));
   expect(screen.getByText('右侧工具仅在会话中使用，请先打开会话')).toBeVisible();
   await user.click(row('diff').querySelector('.task-title-btn')!);
   await screen.findByRole('textbox',{name:'聊天输入'});
   await user.click(screen.getByRole('button',{name:'新建终端'}));
   expect(screen.getByRole('tab',{name:'终端 1'})).toHaveAttribute('aria-selected','true');
   await user.click(screen.getByRole('button',{name:/全部任务树/}));
   expect(screen.getByLabelText('任务属性区域')).toBeVisible();
   expect(screen.getByLabelText('右侧工作区')).not.toBeVisible();
   expect(screen.queryByRole('toolbar',{name:'右侧工具操作'})).not.toBeInTheDocument();
   await user.click(row('diff').querySelector('.task-title-btn')!);
   await screen.findByRole('textbox',{name:'聊天输入'});
   expect(screen.getByRole('tab',{name:'终端 1'})).toHaveAttribute('aria-selected','true');
   expect(screen.queryByRole('tab',{name:'终端 2'})).not.toBeInTheDocument();
 });
 it('keeps task properties fixed in the tree and tool tabs in the conversation top header',async()=>{
   const {user}=await tasksPage();
   expect(screen.getByLabelText('任务属性区域')).toBeVisible();
   expect(screen.queryByRole('button',{name:'收起会话属性'})).not.toBeInTheDocument();
   await user.click(row('diff').querySelector('.task-title-btn')!);
   await screen.findByRole('textbox',{name:'聊天输入'});
   await user.click(screen.getByRole('button',{name:'文件'}));
   const tabs=screen.getByRole('tablist',{name:'右侧工具标签'});
   expect(tabs.closest('header')).toBe(screen.getByRole('banner',{name:'工作区标题栏'}));
   expect(within(tabs).queryByRole('tab',{name:'任务详情'})).not.toBeInTheDocument();
   expect(screen.getByLabelText('右侧工作区')).not.toContainElement(tabs);
   await user.click(screen.getByRole('button',{name:'收起右侧工作区'}));
   expect(screen.getByLabelText('会话属性面板')).not.toBeVisible();
 });
 it('starts conversation properties collapsed and separates conversation actions from tool actions',async()=>{
   const {user}=await tasksPage();await user.click(row('diff').querySelector('.task-title-btn')!);
   await screen.findByRole('textbox',{name:'聊天输入'});
   await user.click(screen.getByRole('button',{name:'切换本任务会话'}));
   await user.click(within(document.querySelector('.workspace-center-header .inline-menu') as HTMLElement).getByRole('button',{name:'实现部署前 Diff'}));
   expect(screen.getByLabelText('会话属性面板')).not.toBeVisible();
   const center=screen.getByRole('toolbar',{name:'会话与任务操作'}),tools=screen.getByRole('toolbar',{name:'右侧工具操作'});
   expect(within(center).getByRole('button',{name:'提取结果'})).toBeInTheDocument();
   expect(within(center).getByRole('button',{name:'会话属性'})).toHaveAttribute('aria-expanded','false');
   expect(within(center).queryByRole('button',{name:'文件'})).not.toBeInTheDocument();
   expect(within(tools).getByRole('button',{name:'文件'})).toBeInTheDocument();
   await user.click(within(center).getByRole('button',{name:'会话属性'}));
   expect(screen.getByLabelText('会话属性面板')).toBeVisible();
   await user.click(within(tools).getByRole('button',{name:'新建终端'}));
   await user.click(screen.getByRole('button',{name:'提取结果'}));
   await waitFor(()=>expect(screen.getByRole('tab',{name:'上下文与结果'})).toHaveAttribute('aria-selected','true'));
   expect(screen.getByRole('tab',{name:'终端 1'})).toHaveAttribute('aria-selected','true');
   await user.click(screen.getByRole('button',{name:'收起会话属性'}));
   expect(screen.getByLabelText('会话属性面板')).not.toBeVisible();
   await user.click(screen.getByRole('button',{name:'收起右侧工作区'}));
   await user.click(screen.getByRole('button',{name:'展开右侧工作区'}));
   expect(screen.getByRole('tab',{name:'终端 1'})).toHaveAttribute('aria-selected','true');
   expect(screen.queryByRole('tab',{name:'终端 2'})).not.toBeInTheDocument();
 });
 it('reuses files, opens multiple terminals and preserves their tabs across other pages',async()=>{
   const {user}=await tasksPage();await user.click(row('diff').querySelector('.task-title-btn')!);await screen.findByRole('textbox',{name:'聊天输入'});
   await user.click(screen.getByRole('button',{name:'文件'}));
   await user.click(screen.getByRole('button',{name:'新建终端'}));
   await user.click(screen.getByRole('button',{name:'新建终端'}));
   const tabs=screen.getByRole('tablist',{name:'右侧工具标签'});
   expect(within(tabs).getByRole('tab',{name:'终端 1'})).toBeInTheDocument();
   expect(within(tabs).getByRole('tab',{name:'终端 2'})).toHaveAttribute('aria-selected','true');
   await user.click(screen.getByRole('button',{name:'文件'}));await user.click(screen.getByRole('button',{name:'文件'}));
   expect(within(tabs).getAllByRole('tab',{name:'文件'})).toHaveLength(1);
   await user.click(screen.getByRole('button',{name:'项目'}));await user.click(screen.getByRole('button',{name:'任务'}));
   expect(screen.getByLabelText('右侧工作区')).not.toBeVisible();
   await user.click(row('diff').querySelector('.task-title-btn')!);
   await screen.findByRole('textbox',{name:'聊天输入'});
   expect(within(screen.getByRole('tablist',{name:'右侧工具标签'})).getByRole('tab',{name:'终端 2'})).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'收起右侧工作区'}));
   expect(screen.getByLabelText('右侧工作区')).not.toBeVisible();
 });
 it('opens the task tree by default with tasks before conversations and matching numbered shortcuts',async()=>{
   render(<ChatApp api={createDemoApi()}/>);
   await screen.findByRole('region',{name:'全局任务树'});
   const nav=screen.getByRole('navigation',{name:'主导航'});
   expect(within(nav).getAllByRole('button').slice(0,2).map(x=>x.getAttribute('aria-label'))).toEqual(['任务','会话']);
   expect(within(nav).getByRole('button',{name:'任务'})).toHaveAttribute('aria-current','page');
   fireEvent.keyDown(document,{key:'2',metaKey:true});
   expect(within(nav).getByRole('button',{name:'会话'})).toHaveAttribute('aria-current','page');
   fireEvent.keyDown(document,{key:'1',ctrlKey:true});
   expect(tree()).toBeInTheDocument();
 });
 it('uses one window header across pages while keeping page actions and sidebar control available',async()=>{
   const {user}=await tasksPage();
   expect(screen.getAllByRole('banner')).toHaveLength(1);
   const header=screen.getByRole('banner',{name:'工作区标题栏'});
   expect(within(header).getByRole('button',{name:'切换侧栏'})).toBeEnabled();
   await user.click(within(header).getByRole('button',{name:'新建任务'}));
   expect(screen.getByRole('dialog',{name:'新建任务'})).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'取消'}));
   await user.click(screen.getByRole('button',{name:'项目'}));
   expect(screen.getAllByRole('banner')).toHaveLength(1);
   expect(within(header).getByRole('heading',{name:'项目'})).toBeInTheDocument();
   await user.click(within(header).getByRole('button',{name:'添加本地项目'}));
   expect(screen.getByRole('dialog',{name:'添加本地项目'})).toBeInTheDocument();
 });
 it('shows task execution permissions before any conversation exists and saves them without starting work',async()=>{
   const {api,user}=await tasksPage();
   const before=await api.call<Workspace>('snapshot');
   await user.click(row('review'));
   await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   const picker=screen.getByRole('combobox',{name:'任务执行权限'});
   await chooseOption(user,picker,'完全访问');
   await user.click(screen.getByRole('button',{name:'保存任务权限'}));
   const after=await api.call<Workspace>('snapshot');
   expect(after.tasks.find(t=>t.id==='review')?.execution_permissions).toEqual({sandbox_mode:'danger-full-access',approval_policy:'never'});
   expect(after.conversations).toHaveLength(before.conversations.length);
   expect(after.work_tasks).toHaveLength(before.work_tasks.length);
 });
 it('keeps task properties and the automatic conversation permission entry in sync',async()=>{
   const {api,user}=await tasksPage();
   await user.click(row('contract'));
   await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'任务执行权限'}),'完全访问');
   await user.click(screen.getByRole('button',{name:'保存任务权限'}));
   await user.click(row('contract').querySelector('.task-title-btn')!);
   await user.click(await screen.findByRole('button',{name:'完全访问'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'权限模式'}),'只读');
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   await screen.findByRole('button',{name:'只读'});
   await user.click(screen.getByRole('button',{name:'会话属性'}));
   expect(screen.getByRole('combobox',{name:'任务执行权限'})).toHaveTextContent('只读');
   expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='contract')?.execution_permissions).toEqual({sandbox_mode:'read-only',approval_policy:'on-request'});
 });
 it('rejects a stale task permission draft after another entry changes it',async()=>{
   const {api,user}=await tasksPage();
   await user.click(row('review'));await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'任务执行权限'}),'完全访问');
   await api.call('set_task_permissions',{task_id:'review',permissions:{sandbox_mode:'read-only',approval_policy:'on-request'},expected_permissions:{sandbox_mode:'workspace-write',approval_policy:'on-request'}});
   await user.click(screen.getByRole('button',{name:'保存任务权限'}));
   expect(await screen.findByRole('alert')).toHaveTextContent('任务权限已被修改');
   expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.execution_permissions?.sandbox_mode).toBe('read-only');
 });
 it('keeps the tree after creating a task and selects its details without creating a conversation',async()=>{
   const {api,user}=await tasksPage(),before=await api.call<Workspace>('snapshot');
   await user.click(screen.getByRole('button',{name:'新建任务'}));
   await user.type(screen.getByRole('textbox',{name:'标题'}),'继续编辑的新任务');
   await user.click(screen.getByRole('button',{name:'创建任务'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'新建任务'})).not.toBeInTheDocument());
   expect(tree()).toBeInTheDocument();expect(screen.queryByRole('region',{name:'聊天会话'})).not.toBeInTheDocument();
   const after=await api.call<Workspace>('snapshot'),created=after.tasks.find(t=>t.title==='继续编辑的新任务')!;
   await waitFor(()=>expect(row(created.id)).toHaveFocus());expect(row(created.id)).toHaveClass('highlight');
   expect(screen.getByRole('region',{name:'任务详情'})).toHaveTextContent(created.title);
   expect(after.conversations).toHaveLength(before.conversations.length);
 });
 it('reveals a created child beneath a collapsed parent',async()=>{
   const {api,user}=await tasksPage();
   await user.click(screen.getByRole('button',{name:'折叠 实现部署前 Diff'}));
   fireEvent.contextMenu(row('diff'),{clientX:400,clientY:300});
   await user.click(screen.getByRole('menuitem',{name:'添加子任务'}));
   await user.type(screen.getByRole('textbox',{name:'标题'}),'折叠树里的新任务');await user.click(screen.getByRole('button',{name:'创建任务'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'添加子任务'})).not.toBeInTheDocument());
   const after=await api.call<Workspace>('snapshot'),child=after.tasks.find(t=>t.title==='折叠树里的新任务')!;
   expect(tree()).toBeInTheDocument();await waitFor(()=>expect(row(child.id)).toHaveFocus());
   expect(screen.getByRole('button',{name:'折叠 实现部署前 Diff'})).toBeInTheDocument();
 });
 it('reveals a created task when the current search excludes it and explains the filter reset',async()=>{
   const {api,user}=await tasksPage();await user.type(screen.getByRole('textbox',{name:'搜索全局任务'}),'不存在的匹配');
   await user.click(screen.getByRole('button',{name:'新建任务'}));await user.type(screen.getByRole('textbox',{name:'标题'}),'需要定位的新任务');await user.click(screen.getByRole('button',{name:'创建任务'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'新建任务'})).not.toBeInTheDocument());
   const after=await api.call<Workspace>('snapshot'),created=after.tasks.find(t=>t.title==='需要定位的新任务')!;
   expect(tree()).toBeInTheDocument();await waitFor(()=>expect(row(created.id)).toHaveFocus());
   expect(screen.getByRole('textbox',{name:'搜索全局任务'})).toHaveValue('');expect(screen.getByRole('status')).toHaveTextContent('筛选');
 });
 it('switches to the page containing a newly created task beyond the first 200 rows',async()=>{
   const api=createDemoApi(),user=userEvent.setup();
   for(let i=0;i<201;i++)await api.call('create_task',{title:`列表任务 ${i}`});
   render(<ChatApp api={api}/>);await user.click(screen.getByRole('button',{name:'任务'}));await screen.findByRole('region',{name:'全局任务树'});
   await user.click(screen.getByRole('button',{name:'新建任务'}));await user.type(screen.getByRole('textbox',{name:'标题'}),'第二页的新任务');await user.click(screen.getByRole('button',{name:'创建任务'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'新建任务'})).not.toBeInTheDocument());
   const after=await api.call<Workspace>('snapshot'),created=after.tasks.find(t=>t.title==='第二页的新任务')!;
   expect(tree()).toHaveTextContent('2 / 2');await waitFor(()=>expect(row(created.id)).toHaveFocus());
 });
 it('locates consecutive new tasks when the selected task has no conversation',async()=>{
   const {api,user}=await tasksPage();fireEvent.click(row('review'));
   for(const title of ['连续新建一','连续新建二']){
     await user.click(screen.getByRole('button',{name:'新建任务'}));await user.type(screen.getByRole('textbox',{name:'标题'}),title);await user.click(screen.getByRole('button',{name:'创建任务'}));
     await waitFor(()=>expect(screen.queryByRole('dialog',{name:'新建任务'})).not.toBeInTheDocument());
     const data=await api.call<Workspace>('snapshot'),created=data.tasks.find(t=>t.title===title)!;
     await waitFor(()=>expect(row(created.id)).toHaveFocus());expect(screen.getByRole('region',{name:'任务详情'})).toHaveTextContent(title);
   }
 });
 it.each(['最近 24 小时','周视图 · 最近 7 天','最近 30 天'])('immediately reveals a new task while preserving the %s time filter',async label=>{
   const {api,user}=await tasksPage();await chooseOption(user,screen.getByRole('combobox',{name:'按更新时间筛选'}),label);
   await user.click(screen.getByRole('button',{name:'新建任务'}));await user.type(screen.getByRole('textbox',{name:'标题'}),'时间筛选下立即可见');await user.click(screen.getByRole('button',{name:'创建任务'}));
   await waitFor(()=>expect(screen.queryByRole('dialog',{name:'新建任务'})).not.toBeInTheDocument());
   const data=await api.call<Workspace>('snapshot'),created=data.tasks.find(t=>t.title==='时间筛选下立即可见')!;
   await waitFor(()=>expect(row(created.id)).toHaveFocus());expect(screen.getByRole('combobox',{name:'按更新时间筛选'})).toHaveTextContent(label);
 });
 it('uses a styled listbox for the time filter and keeps selection behavior',async()=>{
   const {user}=await tasksPage();
   const trigger=screen.getByRole('combobox',{name:'按更新时间筛选'});
   expect(trigger.tagName).toBe('BUTTON');
   await user.click(trigger);
   const menu=await screen.findByRole('listbox');
   await user.click(within(menu).getByRole('option',{name:'最近 24 小时'}));
   expect(trigger).toHaveTextContent('最近 24 小时');
   expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
 });
 it('does not restore stale full access after another client has tightened permissions',async()=>{
   const api=createDemoApi(),user=userEvent.setup(),data=await api.call<Workspace>('snapshot');
   const selected=data.conversations.find(c=>c.mode==='manual')!;
   await api.call('update_conversation',{conversation_id:selected.id,revision:selected.revision,patch:{sandbox_mode:'danger-full-access',approval_policy:'never'}});
   render(<ChatApp api={api}/>);await user.click(screen.getByRole('button',{name:'会话'}));await user.click(await screen.findByRole('button',{name:selected.title}));await user.click(screen.getByRole('button',{name:'完全访问'}));
   const opening=(await api.call<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)!;
   await api.call('update_conversation',{conversation_id:selected.id,revision:opening.revision,patch:{sandbox_mode:'read-only',approval_policy:'on-request'}});
   await waitFor(()=>expect(screen.getByRole('button',{name:'只读'})).toBeInTheDocument(),{timeout:4000});
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   expect(await within(screen.getByRole('dialog',{name:'会话权限'})).findByRole('alert')).toHaveTextContent('会话版本已改变');
   expect((await api.call<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config).toEqual(expect.objectContaining({sandbox_mode:'read-only',approval_policy:'on-request'}));
 });
 it('preserves an unsupported legacy policy without resubmitting it and can explicitly migrate it',async()=>{
   const api=createDemoApi(),original=api.call.bind(api),user=userEvent.setup(),data=await original<Workspace>('snapshot');
   const selected=data.conversations.find(c=>c.mode==='manual')!;
   await original('update_conversation',{conversation_id:selected.id,revision:selected.revision,patch:{approval_policy:'on-failure'}});
   const wrapped={...api,call:vi.fn(async(method:string,params?:Record<string,unknown>)=>{
     if(method==='update_conversation'&&(params?.patch as Record<string,unknown>)?.approval_policy==='on-failure')throw Error('不支持的审批策略');
     return original(method,params);
   })} as typeof api;
   render(<ChatApp api={wrapped}/>);await user.click(screen.getByRole('button',{name:'会话'}));await user.click(await screen.findByRole('button',{name:selected.title}));await user.click(screen.getByRole('button',{name:'自定义权限'}));
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
   expect((await original<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config.approval_policy).toBe('on-failure');
   await user.click(screen.getByRole('button',{name:'自定义权限'}));await chooseOption(user,screen.getByRole('combobox',{name:'权限模式'}),'完全访问');await user.click(screen.getByRole('button',{name:'保存会话设置'}));await screen.findByRole('button',{name:'完全访问'});
   expect((await original<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config).toEqual(expect.objectContaining({sandbox_mode:'danger-full-access',approval_policy:'never'}));
 });
 it('keeps mixed legacy permissions visible as custom until an explicit preset is saved',async()=>{
   const api=createDemoApi(),user=userEvent.setup(),data=await api.call<Workspace>('snapshot');
   const selected=data.conversations.find(c=>c.mode==='manual')!;
   await api.call('update_conversation',{conversation_id:selected.id,revision:selected.revision,patch:{sandbox_mode:'danger-full-access',approval_policy:'on-request'}});
   render(<ChatApp api={api}/>);await user.click(screen.getByRole('button',{name:'会话'}));await user.click(await screen.findByRole('button',{name:selected.title}));
   expect(screen.queryByRole('button',{name:'完全访问'})).not.toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'自定义权限'}));
   expect(screen.getByRole('combobox',{name:'权限模式'})).toHaveTextContent('自定义（保留当前设置）');
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   expect((await api.call<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config).toEqual(expect.objectContaining({sandbox_mode:'danger-full-access',approval_policy:'on-request'}));
   await user.click(screen.getByRole('button',{name:'自定义权限'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'权限模式'}),'只读');
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   await screen.findByRole('button',{name:'只读'});
   expect((await api.call<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config).toEqual(expect.objectContaining({sandbox_mode:'read-only',approval_policy:'on-request'}));
 });
 it('enables full access atomically for only the selected existing conversation',async()=>{
   const api=createDemoApi(),user=userEvent.setup(),before=await api.call<Workspace>('snapshot');
   const selected=before.conversations.find(c=>c.mode==='manual')!;
   render(<ChatApp api={api}/>);await user.click(screen.getByRole('button',{name:'会话'}));await user.click(await screen.findByRole('button',{name:selected.title}));
   await user.click(screen.getByRole('button',{name:'按需确认'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'权限模式'}),'完全访问');
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   await screen.findByRole('button',{name:'完全访问'});
   const after=await api.call<Workspace>('snapshot'),current=after.conversations.find(c=>c.id===selected.id)!;
   expect(current.config).toEqual(expect.objectContaining({sandbox_mode:'danger-full-access',approval_policy:'never'}));
   expect(current.thread_id).toBe(selected.thread_id);
   expect(after.conversations.filter(c=>c.id!==selected.id)).toEqual(before.conversations.filter(c=>c.id!==selected.id));
   await user.click(screen.getByRole('button',{name:'完全访问'}));
   await chooseOption(user,screen.getByRole('combobox',{name:'权限模式'}),'按需确认');
   await user.click(screen.getByRole('button',{name:'保存会话设置'}));
   await screen.findByRole('button',{name:'按需确认'});
   expect((await api.call<Workspace>('snapshot')).conversations.find(c=>c.id===selected.id)?.config).toEqual(expect.objectContaining({sandbox_mode:'workspace-write',approval_policy:'on-request'}));
 });
 it.each(['active','stopping','uncertain'])('keeps normal steering but fences %s resource state',async state=>{
   const api=createDemoApi(),original=api.call.bind(api),data=await original<Workspace>('snapshot');
   const selected=data.conversations.find(c=>c.mode==='manual')!;
   const hold={run_id:'native-run',state,error:state==='uncertain'?'停止待核对':null};
   const wrapped={...api,call:vi.fn(async(method:string,params?:Record<string,unknown>)=>{
     const result=await original(method,params);
     if(method==='snapshot')return {...result as Workspace,conversations:(result as Workspace).conversations.map(c=>c.id===selected.id?{...c,runtime_status:state==='active'?'running':state==='stopping'?'stopping':'failed',current_run_id:state==='uncertain'?null:'native-run',resource_hold:hold}:c)};
     return result;
   })} as typeof api;
   const user=userEvent.setup();render(<ChatApp api={wrapped}/>);
   await user.click(screen.getByRole('button',{name:'会话'}));
   if(state==='stopping')await user.click(await screen.findByRole('button',{name:/^阻塞/}));
   await user.click(await screen.findByRole('button',{name:selected.title}));
   await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'补充范围');
   if(state==='active'){expect(screen.getByRole('button',{name:'停止当前执行'})).toBeEnabled();fireEvent.keyDown(screen.getByRole('textbox',{name:'聊天输入'}),{key:'Enter'});await waitFor(()=>expect(wrapped.call).toHaveBeenCalledWith('send',expect.objectContaining({conversation_id:selected.id,text:'补充范围'})));}
   else if(state==='stopping'){expect(screen.getByRole('button',{name:'停止当前执行'})).toBeDisabled();}
   else {expect(screen.getByRole('button',{name:'发送消息'})).toBeDisabled();await user.click(screen.getByRole('button',{name:'已核对进程停止，解除占用'}));expect(wrapped.call).toHaveBeenCalledWith('release_resources',{conversation_id:selected.id,run_id:'native-run'});}
 });
 it('defaults a context-menu child to inherit its parent instead of the selected task project',async()=>{
   const {api,user}=await tasksPage();
   fireEvent.contextMenu(row('review'),{clientX:400,clientY:300});
   await user.click(screen.getByRole('menuitem',{name:'添加子任务'}));
   expect(screen.getByRole('combobox',{name:'默认项目 · 可选'})).toHaveTextContent('继承上级项目');
   await user.type(screen.getByRole('textbox',{name:'标题'}),'继承项目的子任务');
   await user.click(screen.getByRole('button',{name:'创建任务'}));
   const data=await api.call<Workspace>('snapshot');
   const child=data.tasks.find(t=>t.title==='继承项目的子任务')!;
   expect(child.parent_id).toBe('review');
   expect(child.project_id).toBeNull();
 });
 it('keeps exactly one start time field when switching delegated task inspectors',async()=>{
   const base=createDemoApi(),user=userEvent.setup();
   const api={...base,call:async<T,>(method:string,params?:Record<string,unknown>):Promise<T>=>{
     const value=await base.call<T>(method,params);
     if(method==='snapshot'){
       const data=value as Workspace;
       data.work_tasks=data.conversations.filter(c=>c.mode==='auto').map(c=>({task_id:c.task_id,title:c.title,status:'waiting',execution_status:'idle',revision:1,config:c.config,continuation_count:0,updated_at:c.updated_at}));
     }
     return value;
   }};
   render(<ChatApp api={api}/>);
   await screen.findByText('隔离演示 · 不调用模型');
   await user.click(screen.getByRole('button',{name:'任务'}));
   await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   for(const id of ['contract','frontend','contract']){
     await user.click(row(id));
     expect(document.querySelectorAll('input[type="datetime-local"]')).toHaveLength(1);
   }
 });
 it('shows the newly delegated automatic conversation without reopening its task',async()=>{
   const api=createDemoApi(),user=userEvent.setup();
   await api.call('create_task',{title:'自动执行可见性验收',project_id:'release'});
   render(<ChatApp api={api}/>);
   await screen.findByText('隔离演示 · 不调用模型');
   await user.click(screen.getByRole('button',{name:'任务'}));
   await user.click(within(screen.getByLabelText('任务侧栏')).getByRole('button',{name:'自动执行可见性验收'}));
   await user.type(screen.getByRole('textbox',{name:'聊天输入'}),'保留这份草稿');
   const attachment=new File(['证据内容'],'evidence.txt',{type:'text/plain'});
   Object.defineProperty(attachment,'text',{value:async()=> '证据内容'});
   await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement,attachment);
   await screen.findByRole('button',{name:'移除 evidence.txt'});
   await user.click(screen.getByRole('button',{name:'添加上下文或附件'}));
   await user.click(screen.getByRole('button',{name:'导入任务上下文'}));
   await user.click(await screen.findByRole('button',{name:'带入下一条消息'}));
   await user.click(screen.getByRole('button',{name:'会话属性'}));
   await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   await user.click(screen.getByRole('button',{name:'委托给 Codex'}));
   expect(await screen.findByRole('button',{name:'自动带入上下文'})).toBeInTheDocument();
   expect(screen.getByRole('textbox',{name:'聊天输入'})).toHaveValue('保留这份草稿');
   expect(screen.getByRole('button',{name:'移除 evidence.txt'})).toBeInTheDocument();
   expect(screen.getByRole('button',{name:'移除任务上下文'})).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'新建本任务会话'}));
   await waitFor(()=>expect(screen.queryByRole('button',{name:'自动带入上下文'})).not.toBeInTheDocument());
 });
 it('opens conversations without a configuration form',async()=>{const user=userEvent.setup();render(<ChatApp api={createDemoApi()}/>);await user.click(screen.getByRole('button',{name:'会话'}));expect(screen.getByRole('textbox',{name:'聊天输入'})).toBeInTheDocument();expect(screen.queryByRole('textbox',{name:'验收要求'})).not.toBeInTheDocument();});
 it('has two task columns and a permanent combined detail view',async()=>{await tasksPage();expect(tree().querySelector('.table-head')?.children).toHaveLength(2);expect(screen.getByRole('tab',{name:'上下文与结果'})).toHaveAttribute('aria-selected','true');expect(within(screen.getByLabelText('任务侧栏')).queryByText('release-console')).not.toBeInTheDocument();});
 it('opens dependencies from a task context menu, without rename or child pin actions',async()=>{const {user}=await tasksPage();fireEvent.contextMenu(row('frontend'),{clientX:400,clientY:300});const menu=screen.getByRole('menu',{name:'实现前端差异展示 任务菜单'});expect(within(menu).queryByText('重命名任务')).not.toBeInTheDocument();expect(within(menu).queryByText('置顶任务')).not.toBeInTheDocument();await user.click(within(menu).getByRole('menuitem',{name:'设置前置任务'}));const dialog=screen.getByRole('dialog',{name:'为「实现前端差异展示」设置前置任务'});expect(within(dialog).getByLabelText(/明确 Diff 接口契约/)).toBeChecked();expect(within(dialog).queryByText('整理本机运行说明')).not.toBeInTheDocument();expect(within(dialog).getByLabelText(/实现前端差异展示/)).toBeDisabled();});
 it('opens dependencies from its visible waiting chip',async()=>{const {user}=await tasksPage();await user.click(within(tree()).getByRole('button',{name:'等待：明确 Diff 接口契约'}));expect(screen.getByRole('dialog',{name:/为「实现前端差异展示」/})).toBeInTheDocument();});
 it('plus creates only a conversation and keeps task navigation',async()=>{const {api,user}=await tasksPage();const before=await api.call<Workspace>('snapshot');await user.click(screen.getByRole('button',{name:'为 实现部署前 Diff 新建会话'}));await screen.findByRole('button',{name:'切换本任务会话'});const after=await api.call<Workspace>('snapshot');expect(after.tasks.length).toBe(before.tasks.length);expect(after.conversations.length).toBe(before.conversations.length+1);expect(screen.getByLabelText('任务侧栏')).toBeInTheDocument();expect(screen.getByRole('button',{name:'任务'})).toHaveAttribute('aria-current','page');});
 it('keeps blocked work a placeholder on title navigation',async()=>{const {api,user}=await tasksPage();await user.click(row('frontend').querySelector('.task-title-btn')!);await screen.findByText('尚未创建真实 Codex Thread，不消耗模型执行。');expect(screen.getByRole('button',{name:'发送消息'})).toBeDisabled();expect((await api.call<Workspace>('snapshot')).conversations.find(c=>c.task_id==='frontend')?.thread_id).toBeFalsy();expect(screen.getByLabelText('任务侧栏')).toBeInTheDocument();});
 it('sidebar search and global tree search do not drive each other',async()=>{const {user}=await tasksPage();await user.type(screen.getByRole('textbox',{name:'搜索左侧任务'}),'本机');expect(row('contract')).toBeInTheDocument();expect(screen.getByRole('textbox',{name:'搜索全局任务'})).toHaveValue('');await user.type(screen.getByRole('textbox',{name:'搜索全局任务'}),'接口');expect(row('review')).not.toBeInTheDocument();expect(within(screen.getByLabelText('任务侧栏')).getByRole('button',{name:'整理本机运行说明'})).toBeInTheDocument();});
 it('clicking the status circle completes and right-click permits reopening',async()=>{const {api,user}=await tasksPage();await user.click(within(row('review')).getByRole('button',{name:/点击完成，右键改状态/}));await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.status).toBe('completed'));fireEvent.contextMenu(within(row('review')).getByRole('button',{name:/点击完成，右键改状态/}),{clientX:400,clientY:300});await user.click(screen.getByRole('menuitemradio',{name:'进行中'}));await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.status).toBe('in_progress'));});
 it('double-click edits without leaving the tree; Escape discards an unsaved name',async()=>{const {api,user}=await tasksPage();await user.dblClick(row('review').querySelector('.task-title-btn')!);const input=screen.getByRole('textbox',{name:'编辑任务名称 review'});await user.clear(input);await user.type(input,'未保存的修改');await user.keyboard('{Escape}');expect(tree()).toBeInTheDocument();expect(screen.queryByRole('textbox',{name:'编辑任务名称 review'})).not.toBeInTheDocument();expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.title).toBe('整理本机运行说明');});
 it('Cmd+Enter inserts immediately after the edited task and focuses its name',async()=>{const {api,user}=await tasksPage();await user.dblClick(row('contract').querySelector('.task-title-btn')!);fireEvent.keyDown(screen.getByRole('textbox',{name:'编辑任务名称 contract'}),{key:'Enter',metaKey:true});await waitFor(()=>expect(screen.getByRole('textbox',{name:/编辑任务名称 task-/})).toHaveFocus());const d=await api.call<Workspace>('snapshot');const added=d.tasks.find(t=>t.title==='新任务')!;expect(added.parent_id).toBe('diff');expect(added.position).toBe(d.tasks.find(t=>t.id==='contract')!.position+1);expect(d.conversations).toHaveLength(5);});
 it('Tab reparents once; repeated Tab does not further indent',async()=>{const {api,user}=await tasksPage();await user.dblClick(row('review').querySelector('.task-title-btn')!);const input=screen.getByRole('textbox',{name:'编辑任务名称 review'});fireEvent.keyDown(input,{key:'Tab'});await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.parent_id).toBe('regression'));fireEvent.keyDown(input,{key:'Tab'});expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.parent_id).toBe('regression');});
 it('remembers selected inspector tab across task selection',async()=>{const {user}=await tasksPage();await user.click(screen.getByRole('tab',{name:'属性与设置'}));await user.click(row('contract'));expect(screen.getByRole('tab',{name:'属性与设置'})).toHaveAttribute('aria-selected','true');await user.click(screen.getByRole('tab',{name:'上下文与结果'}));await user.click(row('frontend'));expect(screen.getByRole('tab',{name:'上下文与结果'})).toHaveAttribute('aria-selected','true');expect(within(screen.getByLabelText('任务详情')).getByText('实现前端差异展示，保留验证证据。')).toBeInTheDocument();});
 it('preserves context draft when switching tasks',async()=>{const {user}=await tasksPage();await user.click(screen.getByRole('button',{name:'编辑'}));await user.clear(screen.getByRole('textbox',{name:'任务 Markdown 上下文'}));await user.type(screen.getByRole('textbox',{name:'任务 Markdown 上下文'}),'## 草稿\n不合并');await user.click(row('contract'));await user.click(row('diff'));expect(screen.getByRole('textbox',{name:'任务 Markdown 上下文'})).toHaveValue('## 草稿\n不合并');await user.click(screen.getByRole('button',{name:'保存上下文'}));await screen.findByText('不合并');});
 it('settings and attention are regular pages, no legacy navigation',async()=>{const {user}=await tasksPage();await user.click(screen.getByRole('button',{name:'设置'}));expect(screen.getByRole('heading',{name:'工作区设置'})).toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.queryByText(/旧版/)).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'需要你'}));expect(screen.getByRole('heading',{name:'需要你关注'})).toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();});
 it('excluded projects disappear while tasks and old sessions stay',async()=>{const {api,user}=await tasksPage();const before=await api.call<Workspace>('snapshot');await user.click(screen.getByRole('button',{name:'设置'}));await user.type(screen.getByLabelText('添加一个或多个目录（每行一个）'),'/Users/yc/Projects/release-console');await user.click(screen.getByRole('button',{name:'添加目录'}));await user.click(screen.getByRole('button',{name:'保存排除目录'}));await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).projects).toHaveLength(1));const after=await api.call<Workspace>('snapshot');expect(after.tasks.length).toBe(before.tasks.length);expect(after.conversations.length).toBe(before.conversations.length);});
 it('utility panels share a right tabstrip and preserve inspector selection',async()=>{const {user}=await tasksPage();await user.click(row('diff').querySelector('.task-title-btn')!);await screen.findByRole('textbox',{name:'聊天输入'});await user.click(screen.getByRole('button',{name:'会话属性'}));await user.click(screen.getByRole('tab',{name:'属性与设置'}));await user.click(screen.getByRole('button',{name:'侧边浏览器'}));await user.click(screen.getByRole('button',{name:'文件'}));const tabs=screen.getByRole('tablist',{name:'右侧工具标签'});expect(within(tabs).getByRole('tab',{name:'新标签页'})).toBeInTheDocument();expect(within(tabs).getByRole('tab',{name:'文件'})).toHaveAttribute('aria-selected','true');expect(within(tabs).queryByRole('tab',{name:'任务详情'})).not.toBeInTheDocument();expect(screen.getByRole('tab',{name:'属性与设置'})).toHaveAttribute('aria-selected','true');});
 it('renders native Markdown without executing HTML',()=>{const {container}=render(<Markdown text={'## 成果\n<script>alert(1)</script>\n[坏链接](javascript:alert)\n[安全文档](https://example.com)\n```sh\necho test\n```'}/>);expect(container.querySelector('script')).toBeNull();expect(container.querySelector('a[href^="javascript:"]')).toBeNull();expect(screen.getByRole('link',{name:'安全文档'})).toHaveAttribute('rel','noreferrer noopener');});
 it('ignores a late detail response after selecting a different conversation',async()=>{const api=createDemoApi(),original=api.call.bind(api);let release:((x:unknown)=>void)|undefined;const d=await api.call<Workspace>('snapshot'),first=d.conversations[0],second=d.conversations[1];const delayed={...api,call:vi.fn(async(method:string,params?:Record<string,unknown>)=>method==='detail'&&params?.conversation_id===first.id?new Promise(resolve=>{release=resolve}):original(method,params))} as typeof api;const user=userEvent.setup();render(<ChatApp api={delayed}/>);await user.click(screen.getByRole('button',{name:'会话'}));await user.click(await screen.findByRole('button',{name:first.title}));await user.click(screen.getByRole('button',{name:second.title}));await waitFor(()=>expect(delayed.call).toHaveBeenCalledWith('detail',{conversation_id:second.id}));release?.(await original('detail',{conversation_id:first.id}));await waitFor(()=>expect(screen.queryByText('已明确的边界')).not.toBeInTheDocument());});
 it('preserves multiselect, week, project and collapsed filters across navigation',async()=>{
   const {user}=await tasksPage();
   await user.click(screen.getByRole('button',{name:'筛选任务状态'}));
   await user.click(screen.getByRole('button',{name:'全不选'}));
   await user.click(screen.getByLabelText('待办'));await user.click(screen.getByLabelText('进行中'));
   await chooseOption(user,screen.getByRole('combobox',{name:'按更新时间筛选'}),'周视图 · 最近 7 天');
   await user.click(screen.getByRole('button',{name:'筛选任务项目'}));await user.click(screen.getByLabelText('release-console'));
   await user.click(screen.getByRole('button',{name:'筛选任务项目'}));
   await user.click(screen.getByRole('button',{name:'全部折叠'}));
   await user.click(screen.getByRole('button',{name:'设置'}));await user.click(screen.getByRole('button',{name:'任务'}));
   expect(screen.getByRole('button',{name:'筛选任务状态'})).toHaveTextContent('2 种状态');
   expect(screen.getByRole('combobox',{name:'按更新时间筛选'})).toHaveTextContent('周视图 · 最近 7 天');
   expect(screen.getByRole('button',{name:'筛选任务项目'})).toHaveTextContent('1 个项目');
   expect(row('frontend')).not.toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'重置筛选'}));
   expect(row('frontend')).toBeInTheDocument();expect(row('review')).toBeInTheDocument();
   expect(screen.getByRole('combobox',{name:'按更新时间筛选'})).toHaveTextContent('全部更新时间');
 });
 it('expands and collapses filtered paths without discarding the query',async()=>{
   const {user}=await tasksPage();await user.type(screen.getByRole('textbox',{name:'搜索全局任务'}),'前端');
   expect(row('frontend')).toBeInTheDocument();expect(row('contract')).toBeInTheDocument();expect(row('regression')).toBeInTheDocument();expect(row('review')).not.toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'全部折叠'}));expect(row('frontend')).not.toBeInTheDocument();expect(row('diff')).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'全部展开'}));expect(row('frontend')).toBeInTheDocument();
   expect(screen.getByRole('textbox',{name:'搜索全局任务'})).toHaveValue('前端');
 });

 it('最近七天命中一个子任务时显示整树，并区分命中与上下文数量',async()=>{
   const base=createDemoApi(),now=Date.now(),user=userEvent.setup();
   const api={...base,call:async <T,>(method:string,params?:Record<string,unknown>):Promise<T>=>{
     const result=await base.call<T>(method,params);
     if(method==='snapshot'){
       const data=result as Workspace;
       data.tasks=data.tasks.map(t=>({...t,updated_at:new Date(now-(t.id==='contract'?1:2000)*3600000).toISOString()}));
     }
     return result;
   }};
   render(<ChatApp api={api}/>);
   await screen.findByRole('region',{name:'全局任务树'});
   await chooseOption(user,screen.getByRole('combobox',{name:'按更新时间筛选'}),'周视图 · 最近 7 天');
   for(const id of ['diff','contract','frontend','regression'])expect(row(id)).toBeInTheDocument();
   expect(row('review')).not.toBeInTheDocument();
   expect(row('contract')).not.toHaveClass('context-only');
   expect(within(row('frontend')).getByText('同树上下文')).toBeInTheDocument();
   expect(within(tree()).getByText('符合筛选 1 项 · 纳入结果 4 项 · 当前展开 4 项（含同树上下文）')).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'全部折叠'}));
   expect(row('contract')).not.toBeInTheDocument();
   expect(within(tree()).getByText('符合筛选 1 项 · 纳入结果 4 项 · 当前展开 1 项（含同树上下文）')).toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'全部展开'}));
   expect(row('frontend')).toBeInTheDocument();
 });

 it('keyword and state select complete root trees across navigation',async()=>{
   const {api,user}=await tasksPage();
   await user.click(within(row('contract')).getByRole('button',{name:/点击完成，右键改状态/}));
   await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='contract')?.status).toBe('completed'));
   await user.type(screen.getByRole('textbox',{name:'搜索全局任务'}),'接口');
   expect(row('contract')).toBeInTheDocument();
   expect(row('frontend')).toBeInTheDocument();
   expect(row('regression')).toBeInTheDocument();
   expect(row('review')).not.toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'筛选任务状态'}));
   await user.click(screen.getByRole('button',{name:'全不选'}));
   await user.click(screen.getByLabelText('待办'));
   await user.click(screen.getByRole('button',{name:'筛选任务状态'}));
   expect(row('contract')).toBeInTheDocument();
   expect(row('contract')).toHaveClass('context-only');
   expect(row('frontend')).toBeInTheDocument();
   expect(row('regression')).toBeInTheDocument();
   expect(row('diff')).toHaveClass('context-only');
   expect(row('review')).not.toBeInTheDocument();
   await user.click(screen.getByRole('button',{name:'设置'}));
   await user.click(screen.getByRole('button',{name:'任务'}));
   expect(screen.getByRole('textbox',{name:'搜索全局任务'})).toHaveValue('接口');
   expect(screen.getByRole('button',{name:'筛选任务状态'})).toHaveTextContent('1 种状态');
   expect(row('frontend')).toBeInTheDocument();
   expect(row('regression')).toBeInTheDocument();
   expect(row('contract')).toBeInTheDocument();
   expect(row('contract')).toHaveClass('context-only');
 });

});
