import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSelect } from './ProjectSelect';
import { Modal } from './components';
import type { BackendProject } from '../types';

afterEach(cleanup);
const projects = [{id:'a',name:'Alpha',path:'/work/tools'},{id:'b',name:'Beta',path:'/work/app'}] as BackendProject[];
function Picker(){const [value,setValue]=useState('');return <ProjectSelect label="默认项目" value={value} projects={projects} emptyLabel="暂不设置" onValueChange={setValue}/>;}
describe('可搜索的项目下拉',()=>{
 it('按名称和目录组合搜索，键盘确认并恢复焦点',async()=>{
  const user=userEvent.setup();render(<Picker/>);const trigger=screen.getByRole('combobox',{name:'默认项目'});
  await user.click(trigger);const search=screen.getByRole('combobox',{name:'搜索任务项目'});expect(search).toHaveFocus();
  await user.type(search,'BETA work');expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.keyboard('[ArrowDown][Enter]');expect(trigger).toHaveTextContent('Beta');expect(trigger).toHaveFocus();expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await user.click(trigger);await user.click(screen.getByRole('option',{name:'暂不设置'}));expect(trigger).toHaveTextContent('暂不设置');
 });
 it('Escape 仅关闭下拉；重开清空搜索；点外部关闭',async()=>{
  const user=userEvent.setup(),close=vi.fn();render(<Modal title="新建任务" onClose={close}><Picker/><button>其他字段</button></Modal>);
  const trigger=screen.getByRole('combobox',{name:'默认项目'});await user.click(trigger);
  await user.type(screen.getByLabelText('搜索任务项目'),'missing');await user.keyboard('[Enter]');expect(trigger).toHaveTextContent('暂不设置');
  await user.click(screen.getByRole('button',{name:'清除项目搜索'}));expect(screen.getByLabelText('搜索任务项目')).toHaveFocus();
  await user.keyboard('[ArrowDown]');await user.keyboard('[Escape]');expect(close).not.toHaveBeenCalled();expect(trigger).toHaveFocus();
  await user.click(trigger);expect(screen.getByLabelText('搜索任务项目')).toHaveValue('');
  await user.click(screen.getByRole('button',{name:'其他字段'}));expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
 });
 it('Tab 与 Shift+Tab 关闭 portal 并把焦点留在外层弹窗',async()=>{
  const user=userEvent.setup();render(<Modal title="新建任务" onClose={vi.fn()}><Picker/><button>下一字段</button></Modal>);
  const trigger=screen.getByRole('combobox',{name:'默认项目'});await user.click(trigger);
  screen.getByRole('option',{name:'Beta'}).focus();await user.keyboard('[Tab]');
  expect(trigger).toHaveFocus();expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await user.click(trigger);await user.keyboard('[ShiftLeft>][Tab][/ShiftLeft]');expect(trigger).toHaveFocus();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
 });
 it('方向键可以打开，空目录保留继承选项，禁用时不打开',()=>{
  const change=vi.fn();const {rerender}=render(<ProjectSelect label="默认项目" value="" projects={[]} emptyLabel="继承上级项目" onValueChange={change}/>);
  fireEvent.keyDown(screen.getByRole('combobox',{name:'默认项目'}),{key:'ArrowUp'});
  fireEvent.keyDown(screen.getByLabelText('搜索任务项目'),{key:'Enter'});expect(change).toHaveBeenCalledWith('');
  rerender(<ProjectSelect label="默认项目" value="" projects={[]} emptyLabel="继承上级项目" onValueChange={change} disabled/>);
  expect(screen.getByRole('combobox',{name:'默认项目'})).toBeDisabled();
 });
});
