import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { WorkspaceFiles } from './WorkspaceFiles';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
it('keeps the selected file while collapsing and restoring the right directory tree',async()=>{
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>command==='workbench_list_directory'?{entries:args.path==='/project'? [{fileName:'src',isDirectory:true,isFile:false}]:[{fileName:'main.ts',isDirectory:false,isFile:true}]}:{dataBase64: btoa('const answer = 42;')});
 const user=userEvent.setup();render(<WorkspaceFiles taskId="conversation:one" workspace="/project" enabled/>);
 await user.click(await screen.findByRole('button',{name:'展开 src'}));
 await user.click(await screen.findByRole('button',{name:'main.ts'}));
 await screen.findByText('const answer = 42;');
 expect(document.querySelector('.workspace-files-layout')?.firstElementChild).toHaveClass('workspace-file-content');
 await user.click(screen.getByRole('button',{name:'收起目录树'}));
 expect(screen.getByLabelText('项目目录树')).not.toBeVisible();
 expect(screen.getByText('const answer = 42;')).toBeVisible();
 await user.click(screen.getByRole('button',{name:'展开目录树'}));
 expect(screen.getByRole('button',{name:'main.ts'})).toBeVisible();
});
it('does not let a late response from an old project replace the current file',async()=>{
 let release:(v:unknown)=>void=()=>{};
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>command==='workbench_list_directory'?{entries:[{fileName:'a.txt',isDirectory:false,isFile:true}]}:args.taskId==='conversation:one'?new Promise(resolve=>{release=resolve}):{dataBase64:btoa('project two')});
 const user=userEvent.setup(),view=render(<WorkspaceFiles taskId="conversation:one" workspace="/one" enabled/>);
 await user.click(await screen.findByRole('button',{name:'a.txt'}));
 view.rerender(<WorkspaceFiles taskId="conversation:two" workspace="/two" enabled/>);
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench_list_directory',{taskId:'conversation:two',path:'/two'}));
 await user.click(await screen.findByRole('button',{name:'a.txt'}));
 await screen.findByText('project two');release({dataBase64:btoa('project one')});
 await waitFor(()=>expect(screen.queryByText('project one')).not.toBeInTheDocument());
});
it('Markdown文件请求复用当前文件工作区并支持再次打开相同链接',async()=>{
 vi.mocked(invoke).mockImplementation(async(command,args:any)=>command==='workbench_list_directory'?{entries:[]}:{dataBase64:btoa(args.path)});
 const props={taskId:'conversation:one',workspace:'/project',enabled:true};
 const view=render(<WorkspaceFiles {...props} openRequest={{target:'/project/a.md:12',sequence:1}}/>);
 await screen.findByText('/project/a.md');
 view.rerender(<WorkspaceFiles {...props} openRequest={{target:'./b.md',sequence:2}}/>);
 await screen.findByText('/project/./b.md');
 view.rerender(<WorkspaceFiles {...props} openRequest={{target:'/project/a.md:12',sequence:3}}/>);
 await screen.findByText('/project/a.md');
 expect(invoke).toHaveBeenCalledWith('workbench_read_file',{taskId:'conversation:one',path:'/project/a.md'});
});

it('renders Markdown from the file viewer and can switch back to source',async()=>{
 const markdown='## 交付说明\n\n**已完成**\n\n- 中文内容';
 const encoded=btoa(String.fromCharCode(...new TextEncoder().encode(markdown)));
 vi.mocked(invoke).mockImplementation(async(command)=>command==='workbench_list_directory'?{entries:[]}:{dataBase64:encoded});
 const user=userEvent.setup();render(<WorkspaceFiles taskId="conversation:one" workspace="/project" enabled openRequest={{target:'/project/README.md',sequence:1}}/>);
 expect(await screen.findByRole('heading',{name:'交付说明'})).toBeVisible();
 expect(screen.queryByText('## 交付说明')).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'查看 Markdown 源码'}));
 expect(await screen.findByText('## 交付说明')).toBeVisible();
});

it('项目外的文件无法预览时，用户可以用系统应用打开原路径',async()=>{
 vi.mocked(invoke).mockImplementation(async(command)=>{
  if(command==='workbench_list_directory')return {entries:[]};
  if(command==='workbench_read_file')return {dataBase64:btoa('%PDF-1.7')};
  return {opened:true};
 });
 const target='file:///other/design%20draft.pdf';
 render(<WorkspaceFiles taskId="conversation:one" workspace="/project" enabled openRequest={{target,sequence:1}}/>);
 const args={taskId:'conversation:one',path:'/other/design draft.pdf'};
 const button=await screen.findByRole('button',{name:'用系统应用打开'});
 expect(invoke).toHaveBeenCalledWith('workbench_read_file',args);
 expect(invoke).not.toHaveBeenCalledWith('workbench_open_file',args);
 await userEvent.click(button);
 expect(invoke).toHaveBeenCalledWith('workbench_open_file',args);
});
