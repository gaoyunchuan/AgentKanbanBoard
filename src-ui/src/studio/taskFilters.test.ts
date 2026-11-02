import { afterEach, describe, expect, it } from 'vitest';
import { emptyTaskQuery, queryTasks, readTaskQuery, writeTaskQuery, withinUpdateRange, taskQueryForReveal, TASK_QUERY_KEY } from './taskFilters';
import type { StudioTask } from './model';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const now=Date.parse('2026-10-28T10:00:00Z');
const at=(hours:number)=>new Date(now-hours*3600000).toISOString();
const node=(id:string, parent_id:string|null, status:StudioTask['status'], hours:number, project='p'):StudioTask=>({id,parent_id,status,position:0,title:id,pinned:false,process_tracking:'',result_review:'',updated_at:at(hours),created_at:at(2000),project_id:project,effective_project_id:project,metadata_revision:0,blocked_by:[],missing_dependencies:[],results:[]});
const fixture=()=>[node('root',null,'completed',900),node('a','root','todo',3),node('b','root','completed',3),node('leaf','a','in_progress',1),node('other',null,'todo',1,'q')];
afterEach(()=>localStorage.clear());
describe('task query predicates and navigation persistence',()=>{
 it('uses an inclusive rolling 168h interval, excluding future and invalid times',()=>{
   expect(withinUpdateRange(at(168),'week',now)).toBe(true);
   expect(withinUpdateRange(at(168.0001),'week',now)).toBe(false);
   expect(withinUpdateRange(at(0),'week',now)).toBe(true);
   expect(withinUpdateRange(at(-1),'week',now)).toBe(false);
   expect(withinUpdateRange('garbage','week',now)).toBe(false);
 });
 it('combines filters on the same node and displays its entire root tree',()=>{
   const q={...emptyTaskQuery(),states:['in_progress' as const],projects:['p'],updated:'week' as const};
   const r=queryTasks(fixture(),q,now);
   expect([...r.matched]).toEqual(['leaf']);
   expect(r.rows.map(x=>[x.task.id,x.contextOnly])).toEqual([['root',true],['a',true],['leaf',false],['b',true]]);
 });
 it.each(['day','week','month'] as const)('更新时间 %s 命中一个深层子任务后展示完整根树',updated=>{
   const tasks=[node('root',null,'completed',2000),node('branch','root','completed',2000),node('hit','branch','todo',1),node('sibling','branch','cancelled',2000),node('cousin','root','todo',2000),node('descendant','cousin','todo',2000),node('unrelated',null,'todo',2000)];
   const result=queryTasks(tasks,{...emptyTaskQuery(),updated},now);
   expect([...result.matched]).toEqual(['hit']);
   expect(result.rows.map(row=>row.task.id)).toEqual(['root','branch','hit','sibling','cousin','descendant']);
   expect(result.visible.size).toBe(6);
 });
 it('命中根任务也展示所有后代，多节点命中不重复展示树',()=>{
   const tasks=fixture();tasks[0].status='in_progress';
   const result=queryTasks(tasks,{...emptyTaskQuery(),states:['in_progress']},now);
   expect([...result.matched]).toEqual(['root','leaf']);
   expect(result.rows.map(row=>row.task.id)).toEqual(['root','a','leaf','b']);
 });
 it('折叠不删除整树结果，定位未命中的同树任务保持筛选',()=>{
   const tasks=fixture(),query={...emptyTaskQuery(),states:['in_progress' as const],updated:'week' as const,collapsed:['root']};
   const result=queryTasks(tasks,query,now);
   expect([...result.visible].sort()).toEqual(['a','b','leaf','root']);
   expect(result.rows.map(row=>row.task.id)).toEqual(['root']);
   const reveal=taskQueryForReveal(tasks,query,'b',now);
   expect(reveal.filtersReset).toBe(false);
   expect(reveal.query).toEqual({...query,collapsed:[]});
 });
 it('整树补全后的任务定位使用真实分页，保留筛选',()=>{
   const tasks=[node('root',null,'completed',2000),...Array.from({length:201},(_,i)=>({...node(`child-${i}`,'root',i===0?'in_progress':'completed',2000),position:i}))];
   const query={...emptyTaskQuery(),states:['in_progress' as const]};
   const result=taskQueryForReveal(tasks,query,'child-200',now);
   expect(result.filtersReset).toBe(false);
   expect(result.query.page).toBe(1);
   expect(result.query.states).toEqual(['in_progress']);
 });
 it('does not union a project match on an ancestor with a state match on a child',()=>{
   const tasks=fixture();tasks[3].effective_project_id='q';
   expect(queryTasks(tasks,{...emptyTaskQuery(),states:['in_progress'],projects:['p']},now).rows).toEqual([]);
 });
 it('supports multistatus OR, empty states, no-project, and case insensitive context matching',()=>{
   const tasks=fixture();tasks[4].effective_project_id=null;tasks[4].process_tracking='Hello TARGET';
   expect([...queryTasks(tasks,{...emptyTaskQuery(),states:['todo','in_progress'],text:'target',projects:['__none__']},now).matched]).toEqual(['other']);
   expect(queryTasks(tasks,{...emptyTaskQuery(),states:[]},now).rows).toEqual([]);
 });
 it('collapse keeps full-tree results counted after a keyword match',()=>{
   const q={...emptyTaskQuery(),text:'leaf',collapsed:['root']};
   const r=queryTasks(fixture(),q,now);expect(r.rows.map(x=>x.task.id)).toEqual(['root']);expect(r.matched.size).toBe(4);
   expect(queryTasks(fixture(),{...q,collapsed:[]},now).rows.map(x=>x.task.id)).toEqual(['root','a','leaf','b']);
 });
 it('roundtrips query, page, expansion and scroll and validates corrupt storage',()=>{
   const q={...emptyTaskQuery(),text:'接口',states:['todo' as const],projects:['p'],updated:'week' as const,collapsed:['root'],page:2,scroll:420};
   writeTaskQuery(q);expect(readTaskQuery()).toEqual(q);
   localStorage.setItem(TASK_QUERY_KEY,'not json');expect(readTaskQuery()).toEqual(emptyTaskQuery());
   localStorage.setItem(TASK_QUERY_KEY,JSON.stringify({version:1,query:{states:['unknown'],page:-5,scroll:Infinity,updated:'century'}}));
   expect(readTaskQuery()).toEqual({...emptyTaskQuery(),states:[]});
 });
 it('recomputes results from current data while preserving the query',()=>{
   const q={...emptyTaskQuery(),states:['in_progress' as const]};writeTaskQuery(q);
   const tasks=fixture();tasks[3].status='completed';
   expect(queryTasks(tasks,readTaskQuery(),now).matched.size).toBe(0);expect(readTaskQuery().states).toEqual(['in_progress']);
 });
});

// Extensionless imports must also resolve unambiguously on macOS's common
// case-insensitive file systems. TaskFilters.tsx / taskFilters.ts is unsafe.
it('keeps studio module basenames unique across case and script extensions', () => {
  const files = readdirSync(resolve(process.cwd(), 'src/studio'))
    .filter(name => /\.(ts|tsx|js|jsx)$/.test(name));
  const names = files.map(name => name.replace(/\.(ts|tsx|js|jsx)$/, '').toLowerCase());
  expect(new Set(names).size).toBe(names.length);
});
