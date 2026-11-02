import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {StrictMode} from 'react';
import {StudioContext,type StudioState} from './context';
import {RightDock} from './RightDock';
vi.mock('./Inspector',()=>({Inspector:()=>null}));
const {browserFixture}=vi.hoisted(()=>({browserFixture:{controller:undefined as any}}));
vi.mock('./BrowserPane',async()=>{const {useEffect}=await import('react');return{BrowserPane:({onController}:any)=>{useEffect(()=>{if(browserFixture.controller)onController(browserFixture.controller)},[onController]);return null}}});
vi.mock('./WorkspaceTerminal',async()=>{const {forwardRef,useImperativeHandle}=await import('react');return{WorkspaceTerminal:forwardRef(({workspace}:any,ref)=>{useImperativeHandle(ref,()=>({close:async()=>{}}));return <div data-testid="terminal-workspace">{workspace}</div>})}});
afterEach(()=>{cleanup();browserFixture.controller=undefined});
const state=(owner:string,workspace:string,sequence:number,panel:StudioState['panel']='terminal')=>({conversation:{id:owner,config:{workspace}},data:{projects:[]},api:{native:false},panel,toolRequest:sequence?{kind:'terminal',sequence}:undefined,setPanel:vi.fn(),notify:vi.fn()} as unknown as StudioState);
const view=(s:StudioState)=><StudioContext.Provider value={s}><RightDock persistent/></StudioContext.Provider>;
it('binds each terminal directory at creation even if the same conversation project changes',()=>{
 const ui=render(view(state('owner','/one',1)));ui.rerender(view(state('owner','/two',2)));
 expect(screen.getAllByTestId('terminal-workspace').map(x=>x.textContent)).toEqual(['/one','/two']);
});
it('uses the current project when a closed singleton file tab is reopened',()=>{
 const files=(workspace:string,sequence:number)=>({...state('owner',workspace,sequence,'files'),toolRequest:{kind:'files',sequence}} as StudioState);
 const ui=render(view(files('/one',1)));
 fireEvent.click(screen.getByRole('button',{name:'关闭文件标签'}));
 ui.rerender(view(files('/two',2)));
 expect(ui.container.querySelector('.workspace-path')).toHaveTextContent('/two');
});
it('restores a conversation terminal selection after viewing another conversation properties',()=>{
 const ui=render(view(state('one','/one',1)));ui.rerender(view(state('two','/two',0,'properties')));ui.rerender(view(state('one','/one',0,'properties')));
 expect(screen.getByRole('tab',{name:'终端 1'})).toHaveAttribute('aria-selected','true');
});

it('reopens a browser whose final webpage was closed',()=>{
 const start=vi.fn();browserFixture.controller={state:{pages:[],target_id:null},started:true,start,operation:vi.fn()};
 const s={...state('one','/one',0,'browser'),toolRequest:{kind:'browser',sequence:1}} as StudioState;
 render(view(s));expect(start).toHaveBeenCalledOnce();
});

it('dismisses the new-tab menu with Escape and outside pointer actions',()=>{
 render(view(state('one','/one',0,'content')));
 fireEvent.click(screen.getByRole('button',{name:'新建右侧标签'}));expect(screen.getByRole('menu')).toBeVisible();
 fireEvent.keyDown(document,{key:'Escape'});expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'新建右侧标签'}));fireEvent.pointerDown(document.body);expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

it('creates one stable terminal identity per request under StrictMode',()=>{
 render(<StrictMode>{view(state('one','/one',1))}</StrictMode>);
 expect(screen.getByRole('tab',{name:'终端 1'})).toBeInTheDocument();
 expect(screen.getAllByTestId('terminal-workspace')).toHaveLength(1);
});
it('Markdown网页链接创建独立网页标签并继续使用当前会话浏览器',async()=>{
 const operation=vi.fn(async()=>({pages:[]})),start=vi.fn(async()=>{});browserFixture.controller={state:{pages:[],target_id:null},started:false,start,operation};
 const s={...state('one','/one',0,'browser'),toolRequest:{kind:'browser',sequence:1,target:'https://example.com/doc'}} as StudioState;
 render(view(s));expect(operation).toHaveBeenCalledWith('new_page',{url:'https://example.com/doc'});
});

it('inactive task-list tools cannot create resources or replay ignored requests on return',()=>{
 const s=state('one','/one',1,'terminal');
 const ui=render(<StudioContext.Provider value={s}><RightDock available={false}/></StudioContext.Provider>);
 expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument();
 ui.rerender(<StudioContext.Provider value={s}><RightDock available/></StudioContext.Provider>);
 expect(screen.queryByTestId('terminal-workspace')).not.toBeInTheDocument();
 expect(screen.queryByRole('tab',{name:'终端 1'})).not.toBeInTheDocument();
});
