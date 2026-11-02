import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './Pages';
import { StudioContext, type StudioState } from './context';

function state(command: StudioState['command']): StudioState {
  return {
    taskQuery: { keywords: '', status: 'all', projects: [], updated: 'all', collapsed: false, page: 1 } as unknown as StudioState['taskQuery'],
    setTaskQuery: vi.fn(), api: { native: false } as unknown as StudioState['api'],
    data: { tasks: [], projects: [], conversations: [], work_tasks: [], settings: { excluded_project_dirs: [], delegation_permission: 'on-request' }, runtime: { connected: false } },
    detail: null, view: 'settings', panel: 'browser' as StudioState['panel'], setPanel: vi.fn(), openDialog: vi.fn(), setView: vi.fn(),
    openTask: vi.fn(), openConversation: vi.fn(), locateTask: vi.fn(), taskReveal: null, completeTaskReveal: vi.fn(),
    inspectTask: vi.fn(), changeTaskState: vi.fn(), newConversation: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    command, notify: vi.fn(), busy: false,
  };
}

describe('settings page', () => {
  it('把委托默认权限保存为完全访问并保留排除目录', async () => {
    const command = vi.fn(async () => ({ excluded_project_dirs: [], delegation_permission: 'full-access' }));
    render(<StudioContext.Provider value={state(command as unknown as StudioState['command'])}><SettingsPage/></StudioContext.Provider>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: '新任务默认权限' }));
    await user.click(await screen.findByRole('option', { name: '完全访问' }));
    expect(screen.getByText(/不再逐次确认/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存默认权限' }));
    expect(command).toHaveBeenCalledWith('save_settings', { excluded_project_dirs: [], expected_excluded_project_dirs: [], delegation_permission: 'full-access' }, expect.any(String));
  });
});
