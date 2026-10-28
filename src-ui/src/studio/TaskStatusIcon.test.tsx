import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusIcon } from './TaskStatusIcon';
describe('task status shapes',()=>{
 it('uses four distinct shapes, not just different circle colors',()=>{
   const {container}=render(<>{['todo','in_progress','completed','cancelled'].map(status=><StatusIcon key={status} status={status}/>)}</>);
   const shapes=[...container.querySelectorAll('svg')].map(x=>x.innerHTML);
   expect(new Set(shapes).size).toBe(4);
   expect([...container.querySelectorAll('svg')].map(x=>x.getAttribute('data-state-icon'))).toEqual(['todo','in_progress','completed','cancelled']);
 });
 it('does not hide terminal status behind a stale blocker',()=>{
   const {container}=render(<><StatusIcon status="cancelled" blocked/><StatusIcon status="todo" blocked/></>);
   expect(container.querySelectorAll('svg')[0]).toHaveAttribute('data-state-icon','cancelled');
   expect(container.querySelectorAll('svg')[1]).toHaveAttribute('data-state-icon','blocked');
 });
});
