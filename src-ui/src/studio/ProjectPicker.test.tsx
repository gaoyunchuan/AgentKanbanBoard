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


describe('项目键盘导航',()=>{
 it('搜索后上下键只移动高亮，Enter 才确认',()=>{
  const select=vi.fn();render(<ProjectPicker projects={projects} onSelect={select}/>);
  const input=screen.getByLabelText('搜索任务项目');
  fireEvent.change(input,{target:{value:'PROJECT-11 work'}});
  fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'ArrowUp'});
  expect(select).not.toHaveBeenCalled();fireEvent.keyDown(input,{key:'Enter'});
  expect(select).toHaveBeenCalledWith('11');
 });
 it('空结果与输入法确认不会选择项目',()=>{
  const select=vi.fn();render(<ProjectPicker projects={projects} onSelect={select}/>);
  const input=screen.getByLabelText('搜索任务项目');
  fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:'Enter'});fireEvent.compositionEnd(input);
  fireEvent.keyDown(input,{key:'Enter',keyCode:229});
  fireEvent.change(input,{target:{value:'not-found'}});fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'Enter'});
  expect(select).not.toHaveBeenCalled();
 });
 it('候选更新后不确认已消失的项目，键盘可以选择空项目',()=>{
  const select=vi.fn();const {rerender}=render(<ProjectPicker projects={projects} selected="119" onSelect={select}/>);
  rerender(<ProjectPicker projects={projects.slice(0,2)} selected="119" onSelect={select}/>);
  fireEvent.keyDown(screen.getByLabelText('搜索任务项目'),{key:'Enter'});expect(select).toHaveBeenCalledWith('0');
  rerender(<ProjectPicker projects={[]} selected="" emptyLabel="继承上级项目" onSelect={select}/>);
  fireEvent.keyDown(screen.getByLabelText('搜索任务项目'),{key:'Enter'});expect(select).toHaveBeenLastCalledWith('');
 });
});
