import {act,cleanup,render,waitFor} from '@testing-library/react';
import {createRef,StrictMode} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {WorkspaceTerminal,type TerminalHandle} from './WorkspaceTerminal';
const {instances}=vi.hoisted(()=>({instances:[] as any[]}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@xterm/xterm',()=>({Terminal:class {cols=80;rows=24;write=vi.fn();dispose=vi.fn();focus=vi.fn();constructor(){instances.push(this)}open(){}loadAddon(){}onData(fn:any){(this as any).input=fn;return{dispose(){}}}onResize(){return{dispose(){}}}}}));
vi.mock('@xterm/addon-fit',()=>({FitAddon:class {fit(){}dispose(){}}}));
afterEach(()=>{cleanup();vi.clearAllMocks();instances.length=0});
it('keeps two PTY identities and closes only the selected terminal',async()=>{
 let next=0;vi.mocked(invoke).mockImplementation(async(_command,args:any)=>args.method==='start'?{id:`pty-${++next}`,workspace:'/project'}:args.method==='read'?{offset:0,start:0,dataBase64:'',exited:false}:{});
 const one=createRef<TerminalHandle>(),two=createRef<TerminalHandle>();
 render(<><WorkspaceTerminal ref={one} taskId="conversation:one" workspace="/project" enabled active/><WorkspaceTerminal ref={two} taskId="conversation:one" workspace="/project" enabled active/></>);
 await waitFor(()=>expect(instances).toHaveLength(2));
 act(()=>instances[0].input('pwd\r'));act(()=>instances[1].input('cd /tmp\r'));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workspace_terminal',expect.objectContaining({method:'write',id:'pty-2',text:'cd /tmp\r'})));
 await act(()=>one.current!.close());
 expect(invoke).toHaveBeenCalledWith('workspace_terminal',expect.objectContaining({method:'close',id:'pty-1'}));
 expect(vi.mocked(invoke).mock.calls.some(([,args]:any)=>args.method==='close'&&args.id==='pty-2')).toBe(false);
});
it('closes a late starting PTY when its tab is removed',async()=>{
 let release:(value:unknown)=>void=()=>{};
 vi.mocked(invoke).mockImplementation(async(_command,args:any)=>args.method==='start'?new Promise(resolve=>{release=resolve}):{});
 const view=render(<WorkspaceTerminal taskId="conversation:one" workspace="/project" enabled active/>);view.unmount();
 await act(async()=>{release({id:'late',workspace:'/project'});await Promise.resolve()});
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workspace_terminal',expect.objectContaining({method:'close',id:'late'})));
});

it('can close a tab whose PTY failed to start',async()=>{
 vi.mocked(invoke).mockRejectedValue(new Error('最多同时打开 8 个终端'));
 const ref=createRef<TerminalHandle>();render(<WorkspaceTerminal ref={ref} taskId="one" workspace="/project" enabled active/>);
 await waitFor(()=>expect(invoke).toHaveBeenCalled());
 await act(async()=>{await expect(ref.current!.close()).resolves.toBeUndefined()});
});
it('keeps the live PTY usable after StrictMode cleanup of the first setup',async()=>{
 let next=0;vi.mocked(invoke).mockImplementation(async(_command,args:any)=>args.method==='start'?{id:`strict-${++next}`,workspace:'/project'}:args.method==='read'?{offset:0,start:0,dataBase64:'',exited:false}:{});
 const ref=createRef<TerminalHandle>();render(<StrictMode><WorkspaceTerminal ref={ref} taskId="one" workspace="/project" enabled active/></StrictMode>);
 await waitFor(()=>expect(instances.length).toBeGreaterThan(0));
 act(()=>instances[instances.length-1].input('pwd\r'));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workspace_terminal',expect.objectContaining({method:'write',id:'strict-2'})));
 await act(()=>ref.current!.close());
 expect(invoke).toHaveBeenCalledWith('workspace_terminal',expect.objectContaining({method:'close',id:'strict-2'}));
});
