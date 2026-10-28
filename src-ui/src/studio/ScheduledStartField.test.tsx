import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import { createDemoApi } from './demo';
import { toLocalInput, toUtcSeconds } from './ScheduledStartField';
import type { Workspace } from './model';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(()=>Promise.reject('preview must not invoke Tauri'))}));
afterEach(()=>{cleanup();localStorage.clear()});
describe('scheduled task start',()=>{
 it('roundtrips local wall time to UTC and rejects nonexistent dates',()=>{
   const local='2026-11-20T18:30';expect(toLocalInput(toUtcSeconds(local))).toBe(local);
   expect(toUtcSeconds('')).toBeNull();expect(()=>toUtcSeconds('2026-02-30T10:00')).toThrow();expect(()=>toUtcSeconds('bad')).toThrow();
 });
 it('saves and clears a start time without delegating a manual task',async()=>{
   const api=createDemoApi(), user=userEvent.setup();render(<ChatApp api={api}/>);
   await screen.findByText('隔离演示 · 不调用模型');await user.click(screen.getByRole('button',{name:'任务'}));
   await user.click(document.querySelector('[data-task-row="review"]')!);
   await user.click(screen.getByRole('tab',{name:'属性与设置'}));
   const input=screen.getByLabelText(/开始时间 ·/);fireEvent.change(input,{target:{value:'2026-11-20T18:30'}});
   await user.click(screen.getByRole('button',{name:'保存开始时间'}));
   await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.scheduled_start_at).toBe(toUtcSeconds('2026-11-20T18:30')));
   expect((await api.call<Workspace>('snapshot')).work_tasks.some(t=>t.task_id==='review')).toBe(false);
   await user.click(screen.getByRole('button',{name:'清除'}));await user.click(screen.getByRole('button',{name:'保存开始时间'}));
   await waitFor(async()=>expect((await api.call<Workspace>('snapshot')).tasks.find(t=>t.id==='review')?.scheduled_start_at).toBeNull());
 });
});
