import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskExecutionControls } from './TaskExecutionControls';
import { StudioContext, type StudioState } from './context';
import { defaultConfig } from './model';
import type { WorkTask } from '../workbench/types';

afterEach(cleanup);
function setup(status: WorkTask['status'], execution = 'idle') {
  const command = vi.fn().mockResolvedValue({});
  const work: WorkTask = {task_id:'task-a',title:'验收任务',status,execution_status:execution,revision:7,config:defaultConfig('/test'),continuation_count:0,updated_at:'2026-10-28T08:00:00Z'};
  render(<StudioContext.Provider value={{command,busy:false} as unknown as StudioState}><TaskExecutionControls work={work}/></StudioContext.Provider>);
  return {command,user:userEvent.setup()};
}

describe('task execution controls',()=>{
  it('requires concrete feedback before reworking completed work with its revision',async()=>{
    const {command,user}=setup('completed');
    const submit=screen.getByRole('button',{name:'提交反馈并返工'});
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole('textbox',{name:'属性返工反馈'}),'补充证据，重新提交');
    await user.click(submit);
    expect(command).toHaveBeenCalledWith('work_action',{task_id:'task-a',action:'rework',expected_revision:7,feedback:'补充证据，重新提交'},expect.any(String));
  });
  it('can pause waiting work before a real thread exists',async()=>{
    const {command,user}=setup('waiting');
    await user.click(screen.getByRole('button',{name:'暂停自动执行'}));
    expect(command).toHaveBeenCalledWith('work_action',{task_id:'task-a',action:'pause',expected_revision:7},expect.any(String));
  });
  it('requires an explicit resume and blocks it until stopping finishes',async()=>{
    const {command}=setup('paused','stopping');
    expect(screen.getByRole('button',{name:'恢复自动执行'})).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });
});
