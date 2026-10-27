import { describe,it,expect,vi,afterEach } from 'vitest';
import { render,screen,cleanup,fireEvent } from '@testing-library/react';
import { ProjectPicker,matchingProjects } from './ProjectPicker';
const projects=Array.from({length:120},(_,i)=>({id:String(i),name:`Project-${i}`,path:`/Users/test/work/repo-${i}`,active:true,aliases:[]}));
afterEach(cleanup);
describe('project selectors',()=>{
 it('only shows five matches in the composer and searches the entire catalog',()=>{const select=vi.fn();render(<ProjectPicker projects={projects} compact onSelect={select}/>);expect(screen.getAllByRole('option')).toHaveLength(5);fireEvent.change(screen.getByLabelText('检索会话项目'),{target:{value:'repo-119'}});expect(screen.getAllByRole('option')).toHaveLength(1);fireEvent.click(screen.getByRole('option'));expect(select).toHaveBeenCalledWith('119');});
 it('task project modal supports case-insensitive name and path terms',()=>{render(<ProjectPicker projects={projects} onSelect={vi.fn()}/>);fireEvent.change(screen.getByLabelText('搜索任务项目'),{target:{value:'PROJECT-11 work'}});expect(screen.getAllByRole('option')).toHaveLength(11);});
 it('reports empty results rather than silently falling back to first five',()=>{expect(matchingProjects(projects,'unknown',5)).toEqual([]);render(<ProjectPicker projects={projects} compact onSelect={vi.fn()}/>);fireEvent.change(screen.getByLabelText('检索会话项目'),{target:{value:'not-found'}});expect(screen.queryAllByRole('option')).toHaveLength(0);expect(screen.getByText('没有匹配项目')).toBeInTheDocument();});
});
