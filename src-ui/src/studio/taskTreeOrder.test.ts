import { describe, expect, it } from 'vitest';
import { flattenedTasks, type StudioTask } from './model';
import { emptyTaskQuery, queryTasks, taskQueryForReveal } from './taskFilters';

const now = Date.parse('2026-11-02T08:00:00Z');
const node = (id: string, parent_id: string | null, patch: Partial<StudioTask> = {}): StudioTask => ({
  id, parent_id, title: id, position: 0, status: 'todo', pinned: false,
  process_tracking: '', result_review: '', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  project_id: null, effective_project_id: null, metadata_revision: 0,
  blocked_by: [], missing_dependencies: [], results: [], ...patch,
});
const ids = (tasks: StudioTask[]) => flattenedTasks(tasks).map(row => row.task.id);

describe('任务树优先展示待推进分支', () => {
  it('未完成分支优先于全部结束的置顶分支，同组保留置顶和手动顺序', () => {
    const tasks = [
      node('done', null, { status: 'completed', pinned: true }),
      node('cancelled', 'done', { status: 'cancelled' }),
      node('later', null, { position: 3 }),
      node('earlier', null, { status: 'in_progress', position: 2 }),
      node('pinned', null, { pinned: true, position: 4 }),
      node('cancelled-root', null, { status: 'cancelled', position: 1 }),
    ];
    expect(ids(tasks)).toEqual(['pinned', 'earlier', 'later', 'done', 'cancelled', 'cancelled-root']);
  });

  it('每层按整条分支判断，已完成祖先下的未完成后代仍靠前', () => {
    const tasks = [
      node('finished-root', null, { status: 'completed' }),
      node('root', null, { status: 'completed', position: 1 }),
      node('finished-child', 'root', { status: 'cancelled' }),
      node('branch', 'root', { status: 'completed', position: 1 }),
      node('finished-leaf', 'branch', { status: 'completed' }),
      node('pending-leaf', 'branch', { position: 1 }),
    ];
    expect(flattenedTasks(tasks).map(row => [row.task.id, row.depth])).toEqual([
      ['root', 0], ['branch', 1], ['pending-leaf', 2], ['finished-leaf', 2], ['finished-child', 1], ['finished-root', 0],
    ]);
  });

  it('最后一个未完成后代结束后整条分支后移，重新打开后恢复', () => {
    const tasks = [node('root', null), node('leaf', 'root'), node('other', null, { position: 1 })];
    const finished = tasks.map(t => t.id === 'other' ? t : { ...t, status: 'completed' as const });
    expect(ids(finished)).toEqual(['other', 'root', 'leaf']);
    expect(ids(finished.map(t => t.id === 'leaf' ? { ...t, status: 'todo' } : t))).toEqual(['root', 'leaf', 'other']);
  });

  it('筛选和折叠不改变完整分支判断，定位页码使用相同顺序', () => {
    const tasks = [
      node('done', null, { status: 'completed' }),
      node('root', null, { status: 'completed', position: 1 }),
      node('pending', 'root'),
    ];
    const query = { ...emptyTaskQuery(), states: ['completed' as const], collapsed: ['root'] };
    expect(queryTasks(tasks, query, now).rows.map(row => row.task.id)).toEqual(['root', 'done']);
    expect(ids(tasks)).toEqual(['root', 'pending', 'done']);
    const many = Array.from({ length: 200 }, (_, i) => node(`done-${i}`, null, { status: 'completed', position: i }));
    const all = [...many, node('pending', null, { position: 201 })];
    expect(taskQueryForReveal(all, emptyTaskQuery(), 'pending', now).query.page).toBe(0);
    expect(taskQueryForReveal(all, emptyTaskQuery(), 'done-199', now).query.page).toBe(1);
  });
});
