import { describe,it,expect,vi,afterEach } from 'vitest';
import { render,screen,fireEvent,cleanup } from '@testing-library/react';
import { InteractionCard } from './InteractionCard';
import type {TaskInteraction} from './types';
const interaction=(patch:Partial<TaskInteraction>={}):TaskInteraction=>({id:'i',task_id:'t',run_id:'r',request_id:1,kind:'approval',method:'item/commandExecution/requestApproval',payload:{command:'npm test'},status:'pending',created_at:'now',...patch});
afterEach(cleanup);
describe('current-run interaction surface',()=>{
 it('returns an explicit permission decision',()=>{const respond=vi.fn();render(<InteractionCard interaction={interaction()} disabled={false} onRespond={respond}/>);fireEvent.click(screen.getByRole('button',{name:'允许本次'}));expect(respond).toHaveBeenCalledWith({decision:'accept'});});
 it('cannot approve when the owning run is no longer actionable',()=>{const respond=vi.fn();render(<InteractionCard interaction={interaction()} disabled onRespond={respond}/>);fireEvent.click(screen.getByRole('button',{name:'允许本次'}));expect(respond).not.toHaveBeenCalled();});
 it('uses a structured answers map for native user input',()=>{const respond=vi.fn();render(<InteractionCard interaction={interaction({kind:'input',method:'item/tool/requestUserInput',payload:{questions:[{id:'scope',question:'选择范围',options:[{label:'当前项目'}]}]}})} disabled={false} onRespond={respond}/>);fireEvent.click(screen.getByRole('radio',{name:'当前项目'}));fireEvent.click(screen.getByRole('button',{name:'提交回答并继续'}));expect(respond).toHaveBeenCalledWith({answers:{scope:{answers:['当前项目']}}});});
 it('answers a persistent business question without granting permission',()=>{const respond=vi.fn();render(<InteractionCard interaction={interaction({kind:'question',method:'task/question',payload:{question:'目标浏览器？'}})} disabled={false} onRespond={respond}/>);fireEvent.change(screen.getByLabelText('任务问题回答'),{target:{value:'Chrome'}});fireEvent.click(screen.getByRole('button',{name:'提交回答并继续'}));expect(respond).toHaveBeenCalledWith({text:'Chrome'});});
});
