import { afterEach, describe, expect, it } from 'vitest';
import { emptyTaskQuery, queryTasks, readTaskQuery, writeTaskQuery, withinUpdateRange, TASK_QUERY_KEY } from './taskFilters';
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
 it('combines filters on the same node and restores only ancestor paths',()=>{
   const q={...emptyTaskQuery(),states:['in_progress' as const],projects:['p'],updated:'week' as const};
   const r=queryTasks(fixture(),q,now);
   expect([...r.matched]).toEqual(['leaf']);
   expect(r.rows.map(x=>[x.task.id,x.contextOnly])).toEqual([['root',true],['a',true],['leaf',false]]);
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
 it('collapse keeps matches counted and never makes filtered siblings appear',()=>{
   const q={...emptyTaskQuery(),text:'leaf',collapsed:['root']};
   const r=queryTasks(fixture(),q,now);expect(r.rows.map(x=>x.task.id)).toEqual(['root']);expect(r.matched.size).toBe(1);
   expect(queryTasks(fixture(),{...q,collapsed:[]},now).rows.map(x=>x.task.id)).toEqual(['root','a','leaf']);
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
