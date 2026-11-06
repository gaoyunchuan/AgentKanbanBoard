import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,test,vi} from 'vitest';
import ChatApp from './ChatApp';
import {createDemoApi} from './demo';
import type {Workspace} from './model';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.reject('演示不能调用原生服务'))}));
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks()});

test('任务右键设未读显示蓝点，查看会话消除，当前页再次设未读保持到重开',async()=>{
 vi.spyOn(document,'hasFocus').mockReturnValue(true);
 const user=userEvent.setup(),api=createDemoApi();render(<ChatApp api={api}/>);
 const sidebar=await screen.findByRole('complementary',{name:'任务侧栏'});
 const task=within(sidebar).getByRole('button',{name:'实现部署前 Diff'});
 fireEvent.contextMenu(task,{clientX:120,clientY:230});
 await user.click(screen.getByRole('menuitem',{name:'标为未读'}));
 expect(await within(sidebar).findByTitle('未读消息')).toBeInTheDocument();
 expect(task).toHaveAccessibleDescription('有未读消息');
 await user.click(task);
 await waitFor(()=>expect(within(sidebar).queryByTitle('未读消息')).not.toBeInTheDocument());
 fireEvent.contextMenu(task,{clientX:120,clientY:230});await user.click(screen.getByRole('menuitem',{name:'标为未读'}));
 await within(sidebar).findByTitle('未读消息');
 await api.call('detail',{conversation_id:'conversation-35'});
 expect(within(sidebar).getByTitle('未读消息')).toBeInTheDocument();
 await user.click(task);
 await waitFor(()=>expect(within(sidebar).queryByTitle('未读消息')).not.toBeInTheDocument());
});

test('任务树逐个显示会话状态，查看已完成会话只清除该会话的未读', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const user = userEvent.setup();
  const api = createDemoApi();
  const {conversations: [completed, running]} = await api.call<Workspace>('snapshot');
  await api.call('complete_conversation', {conversation_id: completed.id, revision: completed.revision});
  await api.call('mark_unread', {conversation_id: completed.id});
  const fixture = {
    ...api,
    async call<T>(method: string, params?: Record<string, unknown>) {
      const result = await api.call<T>(method, params);
      if (method === 'snapshot') {
        (result as Workspace).conversations.find(c => c.id === running.id)!.runtime_status = 'running';
      }
      return result;
    },
  };
  render(<ChatApp api={fixture}/>);
  const chip = (title: string) => within(document.querySelector('[data-task-row="diff"] .sessions-cell')!)
    .getByRole('button', {name: title});
  await screen.findByText('隔离演示 · 不调用模型');
  expect(chip(completed.title)).toHaveAccessibleDescription('已完成 · 有未读消息');
  expect(within(chip(completed.title)).getByTitle('未读消息')).toBeVisible();
  expect(chip(running.title)).toHaveAccessibleDescription('执行中');
  await user.click(chip(completed.title));
  await screen.findByRole('button', {name: '恢复此会话'});
  await waitFor(async () => {
    const data = await api.call<Workspace>('snapshot');
    expect(data.conversations.find(c => c.id === completed.id)?.unread).toBe(false);
  });
  await user.click(screen.getByRole('button', {name: '任务'}));
  expect(chip(completed.title)).toHaveAccessibleDescription('已完成');
  expect(within(chip(completed.title)).queryByTitle('未读消息')).not.toBeInTheDocument();
  expect(chip(running.title)).toHaveAccessibleDescription('执行中');
});
