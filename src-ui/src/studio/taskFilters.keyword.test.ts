import { describe, expect, it } from 'vitest';
import { emptyTaskQuery, queryTasks } from './taskFilters';
import type { StudioTask } from './model';

const now = Date.parse('2026-10-28T10:00:00Z');
const recent = new Date(now - 3600000).toISOString();
const old = new Date(now - 200 * 3600000).toISOString();
const node = (id: string, parent_id: string | null, patch: Partial<StudioTask> = {}): StudioTask => ({
  id, parent_id, title: id, position: 0, status: 'todo', pinned: false,
  process_tracking: '', result_review: '', updated_at: recent, created_at: old,
  project_id: 'p', effective_project_id: 'p', metadata_revision: 0,
  blocked_by: [], missing_dependencies: [], results: [], ...patch,
});
const fixture = () => [
  node('root', null, { status: 'completed', updated_at: old }),
  node('branch', 'root', { status: 'completed' }),
  node('needle', 'branch', { status: 'completed', updated_at: old }),
  node('sibling', 'branch', { status: 'in_progress' }),
  node('cousin', 'root', { effective_project_id: 'q' }),
  node('descendant', 'cousin'),
  node('unrelated', null),
];
const ids = (result: ReturnType<typeof queryTasks>) => result.rows.map(r => r.task.id);

describe('keyword selects root trees before per-task filters', () => {
  it.each(['root', 'branch', 'needle'])('returns the whole tree when %s matches', text => {
    const result = queryTasks(fixture(), { ...emptyTaskQuery(), text }, now);
    expect(ids(result)).toEqual(['root', 'branch', 'needle', 'sibling', 'cousin', 'descendant']);
    expect(result.matched.size).toBe(6);
    expect(result.rows.every(row => !row.contextOnly)).toBe(true);
  });

  it('matches Markdown context case-insensitively and deduplicates tree hits', () => {
    const tasks = fixture();
    tasks[2].process_tracking = '## Evidence\nNETWORK investigation';
    tasks[4].process_tracking = 'network';
    const result = queryTasks(tasks, { ...emptyTaskQuery(), text: '  NeTwOrK  ' }, now);
    expect(ids(result)).toEqual(['root', 'branch', 'needle', 'sibling', 'cousin', 'descendant']);
    expect(new Set(ids(result)).size).toBe(6);
  });

  it('includes each matching root, not other roots, in the existing tree order', () => {
    const tasks = [...fixture(), node('second', null, { position: 1 }), node('hit', 'second', { title: 'needle too' })];
    expect(ids(queryTasks(tasks, { ...emptyTaskQuery(), text: 'needle' }, now)))
      .toEqual(['root', 'branch', 'needle', 'sibling', 'cousin', 'descendant', 'second', 'hit']);
  });

  it('filters sibling states even when the keyword hit itself has an excluded state', () => {
    const result = queryTasks(fixture(), { ...emptyTaskQuery(), text: 'needle', states: ['todo', 'in_progress'] }, now);
    expect([...result.matched]).toEqual(['sibling', 'cousin', 'descendant']);
    expect(result.rows.map(row => [row.task.id, row.contextOnly])).toEqual([
      ['root', true], ['branch', true], ['sibling', false], ['cousin', false], ['descendant', false],
    ]);
    expect(result.visible.has('needle')).toBe(false);
    expect(result.visible.has('unrelated')).toBe(false);
  });

  it('intersects project and time on each displayed task, independently from the keyword hit', () => {
    const tasks = fixture();
    tasks[3].effective_project_id = 'q';
    tasks[5].status = 'in_progress';
    const result = queryTasks(tasks, {
      ...emptyTaskQuery(), text: 'needle', states: ['in_progress'], projects: ['p'], updated: 'week',
    }, now);
    expect([...result.matched]).toEqual(['descendant']);
    expect(result.rows.map(row => [row.task.id, row.contextOnly]))
      .toEqual([['root', true], ['cousin', true], ['descendant', false]]);
  });

  it('allows a root keyword hit to reveal a child with an explicitly different project', () => {
    const result = queryTasks(fixture(), { ...emptyTaskQuery(), text: 'root', projects: ['q'] }, now);
    expect([...result.matched]).toEqual(['cousin']);
    expect(ids(result)).toEqual(['root', 'cousin']);
  });

  it('applies the week range to nodes, not to the text hit or the entire tree', () => {
    const result = queryTasks(fixture(), { ...emptyTaskQuery(), text: 'needle', updated: 'week' }, now);
    expect([...result.matched]).toEqual(['branch', 'sibling', 'cousin', 'descendant']);
    expect(ids(result)).toEqual(['root', 'branch', 'sibling', 'cousin', 'descendant']);
  });

  it('returns no tree if no keyword matches or no node satisfies the extra filters', () => {
    expect(ids(queryTasks(fixture(), { ...emptyTaskQuery(), text: 'missing' }, now))).toEqual([]);
    expect(ids(queryTasks(fixture(), { ...emptyTaskQuery(), text: 'needle', states: ['cancelled'] }, now))).toEqual([]);
    expect(ids(queryTasks(fixture(), { ...emptyTaskQuery(), text: 'needle', states: [] }, now))).toEqual([]);
  });

  it('keeps ordinary node filtering when the keyword is empty', () => {
    const result = queryTasks(fixture(), { ...emptyTaskQuery(), text: '  ', states: ['in_progress'] }, now);
    expect([...result.matched]).toEqual(['sibling']);
    expect(ids(result)).toEqual(['root', 'branch', 'sibling']);
  });

  it('respects collapse and cached query state without changing the result membership', () => {
    const query = { ...emptyTaskQuery(), text: 'needle', collapsed: ['branch'], page: 2, scroll: 120 };
    const snapshot = JSON.stringify(query);
    const result = queryTasks(fixture(), query, now);
    expect(ids(result)).toEqual(['root', 'branch', 'cousin', 'descendant']);
    expect(result.matched.size).toBe(6);
    expect(ids(queryTasks(fixture(), { ...query, collapsed: [] }, now))).toHaveLength(6);
    expect(JSON.stringify(query)).toBe(snapshot);
  });
});
