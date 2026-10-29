import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Globe, ArrowLeft, ArrowRight, RotateCcw, MousePointer2, Plus, Download, Upload, Power, Radio } from 'lucide-react';
import { useStudio } from './context';
import { useSessionBrowser } from './useSessionBrowser';
import { BrowserSurface } from './BrowserSurface';
import './browser.css';

export function BrowserPane({ active = true }: { active?: boolean }) {
  const studio = useStudio();
  const opened = useRef(new Set<string>());
  const remember = useCallback((owner: string) => {
    opened.current.delete(owner); opened.current.add(owner);
    if (opened.current.size > 4) opened.current.delete(opened.current.values().next().value!);
  }, []);
  const forget = useCallback((owner: string) => { opened.current.delete(owner); }, []);
  const owner = studio.conversation?.id;
  // 按会话重新挂载，旧异步结果与旧连接不能进入新会话；仅恢复最近打开的会话。
  return <SessionBrowserPane key={owner || 'none'} active={active} previouslyOpened={Boolean(owner && opened.current.has(owner))} remember={remember} forget={forget}/>;
}
function SessionBrowserPane({ active, previouslyOpened, remember, forget }: {
  active: boolean; previouslyOpened: boolean; remember: (owner: string) => void; forget: (owner: string) => void;
}) {
  const studio = useStudio(), conversation = studio.conversation;
  const browser = useSessionBrowser(conversation?.id, studio.api.native, active, previouslyOpened);
  const { state, started, waiting, error, operation } = browser;
  const [url, setUrl] = useState('');
  const focusUrl = useRef(false);
  const hasState = Boolean(state);
  useEffect(() => { if (started && hasState && conversation) remember(conversation.id); }, [started, hasState, conversation?.id, remember]);
  const stop = async () => { if (await browser.stop() && conversation) forget(conversation.id); };
  const page = state?.pages.find(value => value.id === state.target_id);
  useEffect(() => { if (!focusUrl.current) setUrl(page?.url === 'about:blank' ? '' : page?.url || ''); }, [page?.url, state?.target_id]);
  const pageOperation = useCallback((method: string, params: Record<string, unknown> = {}) => operation(method, { target_id: state?.target_id, ...params }), [operation, state?.target_id]);
  const command = (method: string) => void operation(method, state?.target_id ? { target_id: state.target_id } : {});
  return <aside className="inspector browser-panel streaming-browser" aria-label="侧边浏览器" hidden={!active}>
    <div className="inspector-head"><Globe size={15}/><span>侧边浏览器</span>{started && <><span className={`browser-connection ${browser.painted ? 'connected' : ''}`} role="status"><Radio size={11}/>{browser.connection}</span><button className="iconbtn" aria-label="关闭浏览器保留登录状态" title="关闭浏览器，保留登录状态" onClick={() => void stop()}><Power size={14}/></button></>}</div>
    {started ? <>
      <div className="browser-controls">
        <div className="browser-toolbar">
          <button className="iconbtn" aria-label="浏览器后退" onClick={() => command('back')}><ArrowLeft size={14}/></button>
          <button className="iconbtn" aria-label="浏览器前进" onClick={() => command('forward')}><ArrowRight size={14}/></button>
          <button className="iconbtn" aria-label="刷新页面" onClick={() => command('reload')}><RotateCcw size={14}/></button>
          <form onSubmit={event => { event.preventDefault(); const value = url.trim(); if (value) void operation('navigate', { target_id: state?.target_id, url: /^(https?:\/\/|about:blank$)/i.test(value) ? value : `https://${value}` }); }}>
            <input aria-label="浏览器地址" value={url} onFocus={() => { focusUrl.current = true; }} onBlur={() => { focusUrl.current = false; }} onChange={event => setUrl(event.target.value)} placeholder="网址或 http://localhost"/>
          </form>
        </div>
        <div className="browser-tabstrip" role="tablist" aria-label="浏览器标签页">
          {state?.pages.map(value => <div className={`browser-tab ${state.target_id === value.id ? 'active' : ''}`} key={value.id}>
            <button role="tab" aria-selected={state.target_id === value.id} title={value.url} onClick={() => void operation('activate_page', { target_id: value.id })}>{value.title || value.url || '新标签页'}</button>
            <button aria-label={`关闭网页 ${value.title || value.url || '新标签页'}`} onClick={() => void operation('close_page', { target_id: value.id })}><X size={12}/></button>
          </div>)}
          <button className="iconbtn" aria-label="新建浏览器标签" onClick={() => void operation('new_page')}><Plus size={15}/></button>
        </div>
      </div>
      {active && <BrowserSurface key={state?.target_id || 'waiting'} frame={browser.frame} painted={browser.painted} rendered={browser.rendered} send={browser.send} operation={pageOperation} upload={browser.upload}
        insertText={browser.insertText}/>}
      <div className="browser-actions">
        <span className="browser-control-owner"><MousePointer2 size={13}/>{state?.human_control ? '你正在控制' : 'Agent 可控制'}</span>
        {state?.human_control && <button className="textbtn outlined" onClick={() => command('release_control')}>交给 Agent</button>}
        <span className="browser-actions-spacer"/>
        <button className="iconbtn" title="选择本机文件，上传到网页文件输入框" aria-label="上传文件到网页" disabled={browser.upload.busy} onClick={() => command('pick_upload')}><Upload size={14}/></button>
        <button className="iconbtn" title="打开当前会话的下载目录" aria-label="打开浏览器下载目录" onClick={() => command('open_downloads')}><Download size={14}/></button>
        <button className="iconbtn" aria-label="重新连接浏览器画面" title="重新连接画面" onClick={browser.reconnect}><RotateCcw size={14}/></button>
      </div>
      {(browser.upload.message || browser.upload.error) && <div className="browser-transfer" role={browser.upload.error ? 'alert' : 'status'}>
        <span>{browser.upload.name && <strong>{browser.upload.name} · </strong>}{browser.upload.error || browser.upload.message}</span>
        {browser.upload.busy && <><progress max={browser.upload.total || 1} value={browser.upload.received} aria-label="文件上传进度"/><button className="textbtn outlined" aria-label="取消文件上传" onClick={browser.upload.cancel}>取消</button></>}
      </div>}
      <div className="browser-footer">状态随应用数据保存 · 关闭浏览器保留登录状态</div>
      {state?.input_interrupted && <p className="browser-input-notice">之前的操作被中断，请检查页面后继续。</p>}
    </> : <div className="browser-start"><Globe size={30}/><h3>和 Agent 共用一个浏览器</h3><p>在这里查看、操作网页，登录后可以交给 Agent 继续。每个会话拥有独立的浏览器，登录状态和标签页随应用数据保存。</p>{!conversation && <p>先选择一个会话。</p>}<button className="textbtn primary" disabled={!conversation || !studio.api.native || waiting} onClick={() => void browser.start()}>{waiting ? '正在准备浏览器…' : '打开侧边浏览器'}</button>{!studio.api.native && <p className="note">请在桌面应用中连接真实浏览器。</p>}</div>}
    {error && <div className="browser-error" role="alert"><p>{error}</p><div className="browser-recovery"><button className="textbtn outlined" disabled={waiting} onClick={() => void browser.start('restart')}>{waiting ? '正在恢复…' : '重试连接'}</button><button className="textbtn outlined" disabled={waiting} onClick={() => void browser.prepare()}>{waiting ? '正在准备…' : '准备浏览器环境'}</button></div></div>}
  </aside>;
}
