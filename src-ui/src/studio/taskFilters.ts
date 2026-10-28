import { ancestors, flattenedTasks, type StudioTask } from './model';

export const TASK_STATES = [
  ['todo', '待办'], ['in_progress', '进行中'], ['completed', '已完成'], ['cancelled', '已取消'],
] as const;
export type TaskState = typeof TASK_STATES[number][0];
export type UpdatedRange = 'all' | 'day' | 'week' | 'month';
export type TaskQuery = {
  text: string;
  states: TaskState[];
  projects: string[];
  updated: UpdatedRange;
  collapsed: string[];
  page: number;
  scroll: number;
};
export const TASK_QUERY_KEY = 'agentkanban.task-query.v1';
export const emptyTaskQuery = (): TaskQuery => ({
  text: '', states: TASK_STATES.map(([id]) => id), projects: [], updated: 'all', collapsed: [], page: 0, scroll: 0,
});
export function readTaskQuery(): TaskQuery {
  const fallback = emptyTaskQuery();
  try {
    const raw = JSON.parse(localStorage.getItem(TASK_QUERY_KEY) || 'null');
    if (!raw || raw.version !== 1 || !raw.query || typeof raw.query !== 'object') return fallback;
    const q = raw.query;
    return {
      text: typeof q.text === 'string' ? q.text : '',
      states: Array.isArray(q.states) ? TASK_STATES.map(([id]) => id).filter(id => q.states.includes(id)) : fallback.states,
      projects: Array.isArray(q.projects) ? [...new Set<string>(q.projects.filter((x: unknown) => typeof x === 'string'))] : [],
      updated: ['all','day','week','month'].includes(q.updated) ? q.updated : 'all',
      collapsed: Array.isArray(q.collapsed) ? q.collapsed.filter((x: unknown) => typeof x === 'string') : [],
      page: Number.isSafeInteger(q.page) && q.page >= 0 ? q.page : 0,
      scroll: Number.isFinite(q.scroll) && q.scroll >= 0 ? q.scroll : 0,
    };
  } catch { return fallback; }
}
export function writeTaskQuery(query: TaskQuery) {
  try { localStorage.setItem(TASK_QUERY_KEY, JSON.stringify({ version: 1, query })); } catch { /* Storage may be unavailable; memory state still works. */ }
}
export function withinUpdateRange(value: string, range: UpdatedRange, now: number): boolean {
  if (range === 'all') return true;
  const at = Date.parse(value);
  const hours = range === 'day' ? 24 : range === 'week' ? 168 : 720;
  return Number.isFinite(at) && at <= now && at >= now - hours * 3600000;
}
/** Apply all predicates to the SAME node, then add only its ancestor path. */
export function queryTasks(tasks: StudioTask[], query: TaskQuery, now: number) {
  const text = query.text.trim().toLocaleLowerCase();
  const matched = new Set(tasks.filter(t =>
    query.states.includes(t.status) &&
    (!query.projects.length || query.projects.includes(t.effective_project_id || '__none__')) &&
    withinUpdateRange(t.updated_at, query.updated, now) &&
    (!text || `${t.title}\n${t.process_tracking}`.toLocaleLowerCase().includes(text))
  ).map(t => t.id));
  const visible = new Set(matched);
  for (const id of matched) for (const parent of ancestors(tasks, id)) visible.add(parent.id);
  const collapsed = new Set(query.collapsed);
  const rows = flattenedTasks(tasks).filter(({task}) => visible.has(task.id) &&
    !ancestors(tasks, task.id).some(parent => collapsed.has(parent.id))
  ).map(row => ({ ...row, contextOnly: !matched.has(row.task.id) }));
  return { rows, matched, visible };
}
