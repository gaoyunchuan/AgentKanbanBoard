import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { RuntimeSettings } from './RuntimeSettings';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
describe('native authentication reuse',()=>{
 it('uses an existing native account without starting a new login',async()=>{
  vi.mocked(invoke).mockResolvedValue({account:{email:'test@example.com',planType:'pro'}});
  render(<RuntimeSettings enabled runtime={{connected:true,executable:'/Applications/Codex.app/Contents/Resources/codex'}} onChanged={()=>{}}/>);
  expect(await screen.findByText('test@example.com · pro')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'登录 ChatGPT'})).not.toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalledWith('workbench_rpc',expect.objectContaining({method:'account/login/start'}));
 });
 it('offers login only after the native account reports no valid session',async()=>{
  vi.mocked(invoke).mockResolvedValue({account:null});render(<RuntimeSettings enabled runtime={{connected:true}} onChanged={()=>{}}/>);
  expect(await screen.findByRole('button',{name:'登录 ChatGPT'})).toBeInTheDocument();
 });
 it('the ordinary connection flow requests autodetection instead of a path form',async()=>{
  vi.mocked(invoke).mockResolvedValue({account:{type:'chatgpt'}});const user=userEvent.setup();
  render(<RuntimeSettings enabled runtime={{connected:false}} onChanged={()=>{}}/>);
  expect(screen.getByLabelText('Codex 可执行文件').closest('details')).not.toHaveAttribute('open');
  await user.click(screen.getByRole('button',{name:'自动检测并连接'}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench_connect',{executable:''}));
 });
});
