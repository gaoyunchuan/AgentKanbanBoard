import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import ChatApp from './ChatApp';
import { createDemoApi } from './demo';

afterEach(() => { cleanup(); localStorage.clear(); });

it('⌘, 从输入框打开设置，其他修饰键不触发', async () => {
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  const input = screen.getByRole('textbox', { name: '搜索全局任务' });
  fireEvent.keyDown(input, { key: ',', metaKey: true, shiftKey: true });
  expect(screen.queryByRole('complementary', { name: '设置侧栏' })).not.toBeInTheDocument();
  expect(fireEvent.keyDown(input, { key: ',', metaKey: true })).toBe(false);
  expect(screen.getByRole('complementary', { name: '设置侧栏' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '任务' }));
  await user.click(screen.getByRole('button', { name: '设置' }));
  expect(screen.getByRole('complementary', { name: '设置侧栏' })).toBeVisible();
});

it('⌘N 在当前任务下新建会话，任务树和空聊天中不创建', async () => {
  const user = userEvent.setup();
  const api = createDemoApi();
  render(<ChatApp api={api}/>);
  const before = await api.call<import('./model').Workspace>('snapshot');
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索全局任务' }), { key: 'n', metaKey: true });
  await user.click(screen.getByRole('button', { name: '会话' }));
  await user.click(screen.getByRole('button', { name: '新聊天' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天输入' }), { key: 'n', metaKey: true });
  expect((await api.call<import('./model').Workspace>('snapshot')).conversations).toHaveLength(before.conversations.length);
  await user.click(await screen.findByRole('button', { name: '交互方案讨论' }));
  const original = (await api.call<import('./model').Workspace>('snapshot')).conversations.find(c => c.title === '交互方案讨论')!;
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天输入' }), { key: 'n', metaKey: true });
  await screen.findByRole('button', { name: '切换本任务会话' });
  await vi.waitFor(async () => expect((await api.call<import('./model').Workspace>('snapshot')).conversations).toHaveLength(before.conversations.length + 1));
  const after = await api.call<import('./model').Workspace>('snapshot');
  expect(after.conversations.find(c => !before.conversations.some(old => old.id === c.id))?.task_id).toBe(original.task_id);
});

it('F2 编辑当前会话名称，保留聊天草稿和其他会话名称', async () => {
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  await user.click(screen.getByRole('button', { name: '会话' }));
  await user.click(screen.getByRole('button', { name: '新聊天' }));
  const composer = screen.getByRole('textbox', { name: '聊天输入' });
  fireEvent.keyDown(composer, { key: 'F2' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  await user.click(await screen.findByRole('button', { name: '交互方案讨论' }));
  await user.type(composer, '待发送草稿');
  fireEvent.keyDown(composer, { key: 'F2', shiftKey: true });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.keyDown(composer, { key: 'F2' });
  const dialog = within(screen.getByRole('dialog', { name: '重命名' }));
  const title = dialog.getByRole('textbox', { name: '标题' });
  expect(title).toHaveFocus();
  expect(title).toHaveValue('交互方案讨论');
  await user.clear(title);
  await user.type(title, '新的会话名');
  fireEvent.keyDown(title, { key: 'F2' });
  expect(title).toHaveValue('新的会话名');
  await user.keyboard('{Enter}');

  expect(await screen.findByRole('button', { name: '新的会话名' })).toBeVisible();
  expect(screen.getByRole('button', { name: '实现部署前 Diff' })).toBeVisible();
  expect(composer).toHaveValue('待发送草稿');
  await user.click(screen.getByRole('button', { name: '任务' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索全局任务' }), { key: 'F2' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('设置侧栏只列设置分类，改键立即生效且可重置', async () => {
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  await user.click(screen.getByRole('button', { name: '设置' }));
  const sidebar = within(screen.getByRole('complementary', { name: '设置侧栏' }));
  expect(sidebar.queryByRole('button', { name: '新聊天' })).not.toBeInTheDocument();
  expect(sidebar.queryByRole('button', { name: '新任务' })).not.toBeInTheDocument();
  await user.click(sidebar.getByRole('button', { name: '快捷键管理' }));
  const binding = screen.getByRole('button', { name: '修改切换左侧边栏快捷键' });
  await user.click(binding);
  fireEvent.keyDown(binding, { key: 't', metaKey: true });
  expect(screen.getByRole('alert')).toHaveTextContent('已被占用');
  for (const key of ['w', 'x']) {
    fireEvent.keyDown(binding, { key, metaKey: true });
    expect(binding).toHaveTextContent('请按快捷键');
  }
  fireEvent.keyDown(binding, { key: 'g', metaKey: true });
  expect(binding).toHaveTextContent('⌘G');
  fireEvent.keyDown(document.body, { key: 'g', metaKey: true });
  expect(screen.queryByRole('complementary', { name: '设置侧栏' })).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: 'g', metaKey: true });
  await user.click(screen.getByRole('button', { name: '恢复默认快捷键' }));
  expect(binding).toHaveTextContent('⌘B');
});

it('Cmd+W 会话主体关闭后回任务树并保留草稿，任务树上关闭键无操作', async () => {
  const key = 'w';
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  await user.click(screen.getByRole('button', { name: '会话' }));
  const input = screen.getByRole('textbox', { name: '聊天输入' });
  await user.type(input, '待发送草稿');
  fireEvent.keyDown(input, { key, metaKey: true });
  expect(screen.getByRole('heading', { name: '全部任务' })).toBeVisible();
  expect(fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索全局任务' }), { key, metaKey: true })).toBe(false);
  expect(screen.getByRole('heading', { name: '全部任务' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '会话' }));
  expect(screen.getByRole('textbox', { name: '聊天输入' })).toHaveValue('待发送草稿');
});

it('⌘T 打开右侧启动页，右栏焦点下 Cmd+W 只关闭该标签', async () => {
  const key = 'w';
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  await user.click(screen.getByRole('button', { name: '会话' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天输入' }), { key: 't', metaKey: true });
  const address = screen.getByRole('textbox', { name: '输入网址' });
  expect(address).toBeVisible();
  expect(address).toHaveFocus();
  fireEvent.keyDown(address, { key, metaKey: true });
  expect(screen.queryByRole('tab', { name: '新标签页' })).not.toBeInTheDocument();
  const composer = screen.getByRole('textbox', { name: '聊天输入' });
  fireEvent.keyDown(composer, { key, metaKey: true, repeat: true });
  expect(composer).toBeVisible();
});

it('旧 X 关闭配置不再生效，会话和右栏输入框的 Cmd+X 留给原生剪切', async () => {
  localStorage.setItem('akb.workspace.shortcuts.v1', JSON.stringify({ sidebar: 'G', newTab: 'T', close: 'X' }));
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  await user.click(screen.getByRole('button', { name: '会话' }));
  const composer = screen.getByRole('textbox', { name: '聊天输入' });
  await user.type(composer, '保留草稿');
  expect(fireEvent.keyDown(composer, { key: 'x', metaKey: true })).toBe(true);
  expect(composer).toBeVisible();
  fireEvent.keyDown(composer, { key: 't', metaKey: true });
  const address = screen.getByRole('textbox', { name: '输入网址' });
  expect(fireEvent.keyDown(address, { key: 'x', metaKey: true })).toBe(true);
  expect(address).toBeVisible();
  fireEvent.keyDown(address, { key: 'w', metaKey: true });
  expect(screen.queryByRole('tab', { name: '新标签页' })).not.toBeInTheDocument();
  expect(composer).toHaveValue('保留草稿');
});

it('推荐网址只取自设置中的手动配置，重挂载后可以直接点击', async () => {
  const user = userEvent.setup();
  const api = createDemoApi();
  const first = render(<ChatApp api={api}/>);
  await user.click(screen.getByRole('button', { name: '设置' }));
  await user.type(screen.getByRole('textbox', { name: '显示名称（可选）' }), '测试站');
  await user.type(screen.getByRole('textbox', { name: '网址' }), 'https://example.com/docs');
  await user.click(screen.getByRole('button', { name: '添加推荐网址' }));
  first.unmount();
  render(<ChatApp api={api}/>);
  await user.click(screen.getByRole('button', { name: '会话' }));
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天输入' }), { key: 't', metaKey: true });
  expect(screen.getByRole('button', { name: '测试站' })).toHaveAttribute('title', 'https://example.com/docs');
});

it('Ctrl 加 1 左边的物理键每次新开一个右侧终端，任务树中不打开', async () => {
  const user = userEvent.setup();
  render(<ChatApp api={createDemoApi()}/>);
  const pressTerminal = (target: HTMLElement) => fireEvent.keyDown(target, { key: '·', code: 'Backquote', ctrlKey: true });
  pressTerminal(screen.getByRole('textbox', { name: '搜索全局任务' }));
  expect(screen.queryByRole('tab', { name: '终端 1' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '会话' }));
  const composer = screen.getByRole('textbox', { name: '聊天输入' });
  pressTerminal(composer);
  pressTerminal(composer);
  expect(screen.getByRole('tab', { name: '终端 1' })).toBeVisible();
  expect(screen.getByRole('tab', { name: '终端 2' })).toHaveAttribute('aria-selected', 'true');
  expect(composer).toHaveValue('');
});
