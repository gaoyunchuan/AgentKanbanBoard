import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings2, LoaderCircle, ExternalLink, CheckCircle2 } from 'lucide-react';
import { record } from './events';
import type { WorkbenchData } from './types';

export function RuntimeSettings({ enabled, runtime, onChanged }: {
  enabled: boolean;
  runtime?: WorkbenchData['runtime'];
  onChanged: () => Promise<void> | void;
}) {
  const [executable, setExecutable] = useState(runtime?.configured_executable === 'codex' ? '' : runtime?.configured_executable || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [account, setAccount] = useState<Record<string, unknown> | null>(null);
  const [accountRead, setAccountRead] = useState(false);
  const [login, setLogin] = useState<{ id?: string; url?: string }>();
  const channel = runtime?.account_channel ?? 'personal';
  const personal = channel === 'personal';

  const loadAccount = async () => {
    const response = record(await invoke('workbench_rpc', { method: 'account/read', params: {} }));
    setAccount(response.account ? record(response.account) : null);
    setAccountRead(true);
  };

  useEffect(() => {
    if (!enabled || !runtime?.connected || !personal) return;
    let current = true;
    setAccountRead(false);
    void invoke('workbench_rpc', { method: 'account/read', params: {} }).then(value => {
      if (!current) return;
      const response = record(value);
      setAccount(response.account ? record(response.account) : null);
      setAccountRead(true);
    }).catch(e => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [enabled, runtime?.connected, personal]);

  const run = async (action: () => Promise<unknown>) => {
    if (!enabled || busy) return;
    setBusy(true);
    setError('');
    try { await action(); await onChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const connect = () => run(async () => {
    await invoke('workbench_connect', { executable: executable.trim() });
    if (personal) await loadAccount();
  });
  const switchAccount = (next: typeof channel) => run(async () => {
    await invoke('workbench_switch_account', { channel: next });
    setLogin(undefined);
    setAccount(null);
    setAccountRead(false);
  });
  const startLogin = () => run(async () => {
    const response = record(await invoke('workbench_rpc', {
      method: 'account/login/start', params: { type: 'chatgpt' },
    }));
    setLogin({
      id: typeof response.loginId === 'string' ? response.loginId : undefined,
      url: typeof response.authUrl === 'string' && response.authUrl.startsWith('https:') ? response.authUrl : undefined,
    });
  });

  return <section className="settings-section runtime-settings">
    <h3><Settings2 size={18}/>Codex 连接与账户 <span className={`pill ${runtime?.connected ? 'green' : ''}`}>{!enabled ? '预览模式' : runtime?.connected ? '已连接' : '未连接'}</span></h3>
    {(runtime?.joycode_available || !personal) && <>
      <div className="settings-actions" role="group" aria-label="模型账户">
        <button className="textbtn outlined" aria-pressed={personal} disabled={!enabled || busy || personal} onClick={() => void switchAccount('personal')}>个人 Codex</button>
        <button className="textbtn outlined" aria-pressed={!personal} disabled={!enabled || busy || !personal} onClick={() => void switchAccount('joycode')}>JoyCode</button>
      </div>
      <p>当前账户：{personal ? '个人 Codex' : 'JoyCode'}。空闲时可切换，保留任务、会话和草稿。</p>
    </>}
    <p>{personal ? '复用 Codex Desktop 或 CLI 的已有登录。' : '请保持 JoyCode 桌面版打开并登录。模型由 JoyCode 提供。'}</p>
    {runtime?.connected && <div className="account-card"><CheckCircle2 size={18}/>
      <span>{!personal ? '使用 JoyCode 桌面版登录' : account?.email ? String(account.email) : accountRead ? (account ? '已读取本机账户' : '未发现有效登录') : '正在读取本机登录…'}
        {personal && account?.planType ? ` · ${String(account.planType)}` : ''}
      </span>
    </div>}
    {runtime?.executable && <p className="note runtime-path">程序路径：<code>{runtime.executable}</code>{runtime.server_version && <> · {runtime.server_version}</>}</p>}
    <div className="settings-actions">
      <button className="textbtn outlined" disabled={!enabled || busy} onClick={() => void connect()}>{busy && <LoaderCircle size={14} className="spin"/>}{runtime?.connected ? '重新检测连接' : '自动检测并连接'}</button>
      {personal && runtime?.connected && <button className="textbtn" disabled={busy} onClick={() => void run(loadAccount)}>刷新账户状态</button>}
      {personal && enabled && runtime?.connected && accountRead && !account && <button className="textbtn primary" disabled={busy} onClick={() => void startLogin()}>登录 ChatGPT</button>}
    </div>
    {personal && login?.url && <div className="account-card">
      <button className="textbtn" onClick={() => void run(() => invoke('open_external_link', { target: login.url }))}><ExternalLink size={14}/>打开登录页面</button>
      <button className="textbtn" onClick={() => void run(loadAccount)}>已登录，检查状态</button>
      {login.id && <button className="textbtn" onClick={() => void run(async () => {
        await invoke('workbench_rpc', { method: 'account/login/cancel', params: { loginId: login.id } });
        setLogin(undefined);
      })}>取消登录</button>}
    </div>}
    <details className="advanced-connection">
      <summary>高级：覆盖可执行文件路径</summary>
      <p className="note">仅用于自定义安装位置。留空恢复自动发现，不会更换 HOME 或 CODEX_HOME。</p>
      <label>Codex 可执行文件<input aria-label="Codex 可执行文件" value={executable} onChange={e => setExecutable(e.target.value)} placeholder="自动发现，无需填写"/></label>
      <button className="textbtn outlined" disabled={!enabled || busy} onClick={() => void connect()}>应用并连接</button>
    </details>
    {(error || runtime?.last_error || runtime?.error) && <p role="alert" className="form-error" style={{ whiteSpace: 'pre-wrap' }}>{error || runtime?.last_error || runtime?.error}</p>}
    {!enabled && <p className="note">隔离预览不会读取本机登录或启动进程。</p>}
  </section>;
}
