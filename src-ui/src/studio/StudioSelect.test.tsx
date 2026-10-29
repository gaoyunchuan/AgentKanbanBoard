import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StudioSelect } from './StudioSelect';
import { Modal } from './components';

afterEach(cleanup);
function Picker() {
  const [value,setValue]=useState('');
  return <><StudioSelect label="测试选择" value={value} onValueChange={setValue} options={[{value:'',label:'使用默认'},{value:'option:0',label:'真实业务值'},{value:'disabled',label:'不可选择',disabled:true},{value:'last',label:'最后一项'}]}/><output aria-label="当前值">{value||'EMPTY'}</output></>;
}

describe('workbench custom select',()=>{
  it('roundtrips default empty values without colliding with real option values',async()=>{
    const user=userEvent.setup();render(<Picker/>);
    const trigger=screen.getByRole('combobox',{name:'测试选择'});
    await user.click(trigger);await user.click(screen.getByRole('option',{name:'真实业务值'}));
    expect(screen.getByLabelText('当前值')).toHaveTextContent('option:0');
    await user.click(trigger);await user.click(screen.getByRole('option',{name:'使用默认'}));
    expect(screen.getByLabelText('当前值')).toHaveTextContent('EMPTY');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('supports keyboard selection while skipping disabled options',async()=>{
    const user=userEvent.setup();render(<Picker/>);
    const trigger=screen.getByRole('combobox',{name:'测试选择'});trigger.focus();
    await user.keyboard('[ArrowDown]');
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await user.keyboard('[ArrowDown][ArrowDown][Enter]');
    expect(screen.getByLabelText('当前值')).toHaveTextContent('last');
    expect(trigger).toHaveFocus();
  });
  it('keeps an existing value while options load and uses its label when available',()=>{
    const changed=vi.fn();
    const {rerender}=render(<StudioSelect label="模型" value="legacy-model" options={[]} onValueChange={changed}/>);
    expect(screen.getByRole('combobox',{name:'模型'})).toHaveTextContent('legacy-model');
    rerender(<StudioSelect label="模型" value="legacy-model" options={[{value:'legacy-model',label:'已有模型'}]} onValueChange={changed}/>);
    expect(screen.getByRole('combobox',{name:'模型'})).toHaveTextContent('已有模型');expect(changed).not.toHaveBeenCalled();
  });
  it('does not open or change a disabled control',async()=>{
    const changed=vi.fn(),user=userEvent.setup();
    render(<StudioSelect label="不可用设置" value="a" options={[{value:'a',label:'当前值'}]} onValueChange={changed} disabled/>);
    const trigger=screen.getByRole('combobox',{name:'不可用设置'});expect(trigger).toBeDisabled();await user.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();expect(changed).not.toHaveBeenCalled();
  });
  it('Escape closes only the list inside a modal and restores focus without changing value',async()=>{
    const user=userEvent.setup(),closed=vi.fn();
    function Dialog(){const [open,setOpen]=useState(true);return open?<Modal title="业务弹窗" onClose={()=>{closed();setOpen(false)}}><Picker/></Modal>:null;}
    render(<Dialog/>);const trigger=screen.getByRole('combobox',{name:'测试选择'});
    await user.click(trigger);expect(await screen.findByRole('listbox')).toBeInTheDocument();
    await user.keyboard('[Escape]');
    expect(screen.getByRole('dialog',{name:'业务弹窗'})).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();expect(trigger).toHaveFocus();
    expect(within(screen.getByRole('dialog')).getByLabelText('当前值')).toHaveTextContent('EMPTY');expect(closed).not.toHaveBeenCalled();
  });
});
