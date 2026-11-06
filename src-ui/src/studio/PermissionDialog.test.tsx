import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialogs } from './Dialogs';
import { StudioContext, type StudioState } from './context';
import { defaultConfig, type Conversation } from './model';

const conversation: Conversation = { id: 'c', task_id: 't', title: '运行中的任务', mode: 'auto', project_id: 'p', config: defaultConfig('/tmp'), runtime_status: 'running', current_run_id: 'run-1', pinned: false, closed: false, revision: 3, created_at: '', updated_at: '' };

function state(command: StudioState['command']): StudioState {
  return {
    taskQuery: {} as StudioState['taskQuery'], setTaskQuery: vi.fn(), api: { native: false } as unknown as StudioState['api'],
    data: { tasks: [], projects: [], conversations: [conversation], work_tasks: [] }, detail: null, task: undefined, conversation,
    view: 'chat', panel: 'browser' as StudioState['panel'], setPanel: vi.fn(), openDialog: vi.fn(), setView: vi.fn(), openTask: vi.fn(),
    openConversation: vi.fn(), locateTask: vi.fn(), taskReveal: null, completeTaskReveal: vi.fn(), inspectTask: vi.fn(), changeTaskState: vi.fn(),
    newConversation: vi.fn(async () => {}), completeConversation: vi.fn(async () => {}), refresh: vi.fn(async () => {}), command, notify: vi.fn(), busy: false,
  };
}

describe('permission dialog', () => {
  it('运行中的会话仍可修改权限，保存后提示下一轮生效', async () => {
    const command = vi.fn(async () => ({}));
    render(<StudioContext.Provider value={state(command as unknown as StudioState['command'])}>
      <Dialogs dialog={{ kind: 'permissions' }} onClose={vi.fn()} onImport={vi.fn()}/>
    </StudioContext.Provider>);
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: '保存会话设置' })).toBeEnabled();
    expect(screen.getByText(/下一轮开始生效/)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: '权限模式' }));
    await user.click(await screen.findByRole('option', { name: '完全访问' }));
    await user.click(screen.getByRole('button', { name: '保存会话设置' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith('update_conversation', {
      conversation_id: 'c', revision: 3, patch: { sandbox_mode: 'danger-full-access', approval_policy: 'never' },
    }, '会话设置已保存'));
  });
});
