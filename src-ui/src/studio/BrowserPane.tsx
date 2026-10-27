import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Globe, ArrowLeft, ArrowRight, RotateCcw, ArrowUpRight, MousePointer2, Plus } from "lucide-react";
import { useStudio } from "./context";

type Frame = { data: string; width: number; height: number; target_id: string; title: string; url: string; pages: { id: string; title: string; url: string }[] };
export function BrowserPane({active=true}:{active?:boolean}) {
  const s = useStudio(), c = s.conversation;
  const [frame, setFrame] = useState<Frame>();
  const [inputText, setInputText] = useState('');
  const [url, setUrl] = useState('http://localhost:3000');
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [target, setTarget] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const busy = useRef(false), alive = useRef(true), focusUrl = useRef(false);
  const owner = useRef(c?.id); owner.current=c?.id;
  const [startedOwners, setStartedOwners] = useState(new Set<string>());
  const operation = async (method: string, params: Record<string, unknown> = {}) => {
    if (!c || !s.api.native) return;
    try { return await invoke('chat_browser', { conversationId: c.id, method, params: { target_id: target, ...params } }); }
    catch (e) { if (alive.current && owner.current === c.id) setError(String(e)); throw e; }
  };
  useEffect(() => { setStarted(Boolean(c && startedOwners.has(c.id))); setFrame(undefined); setTarget(undefined); setError(''); }, [c?.id]);
  useEffect(() => {
    alive.current = true; let stale = false;
    const tick = async () => { if (!active || !started || !c || !s.api.native || busy.current) return; busy.current = true; try { const box = viewport.current?.getBoundingClientRect(); const value = await invoke<Frame>('chat_browser', { conversationId: c.id, method: 'frame', params: { target_id: target, width: Math.max(320, Math.round(box?.width || 580)), height: Math.max(260, Math.round(box?.height || 700)) } }); if (!stale) { setFrame(value); if (target && value.target_id !== target) setTarget(value.target_id); if (!focusUrl.current) setUrl(value.url === 'about:blank' ? '' : value.url); setError(''); } } catch (e) { if (!stale) setError(String(e)); } finally { busy.current = false; } };
    void tick(); const timer = setInterval(() => void tick(), 900);
    return () => { stale = true; alive.current = false; clearInterval(timer); };
  }, [active, started, c?.id, target, s.api.native]);
  const start = async () => {
    if (!c || waiting || !s.api.native) return;
    setWaiting(true); setError('');
    try { if (!c.thread_id && !c.config.browser_enabled) await s.command('update_conversation', { conversation_id: c.id, revision: c.revision, patch: { browser_enabled: true } }); await operation('status'); setStartedOwners(v=>new Set([...v,c.id])); if(owner.current===c.id)setStarted(true); }
    catch { /* Inline actionable error stays visible. */ } finally { setWaiting(false); }
  };
  return <aside className="inspector browser-panel" aria-label="侧边浏览器"><div className="inspector-head"><Globe size={15}/>侧边浏览器</div><div className="browser-controls"><div className="browser-toolbar"><button className="iconbtn" aria-label="浏览器后退" disabled={!started} onClick={() => void operation('back').catch(() => {})}><ArrowLeft size={14}/></button><button className="iconbtn" aria-label="浏览器前进" disabled={!started} onClick={() => void operation('forward').catch(() => {})}><ArrowRight size={14}/></button><button className="iconbtn" aria-label="刷新页面" disabled={!started} onClick={() => void operation('reload').catch(() => {})}><RotateCcw size={14}/></button><form onSubmit={e => { e.preventDefault(); void operation('navigate', { url: /^https?:\/\//i.test(url) ? url : `https://${url}` }).catch(() => {}); }}><input aria-label="浏览器地址" value={url} onFocus={() => { focusUrl.current = true; }} onBlur={() => { focusUrl.current = false; }} onChange={e => setUrl(e.target.value)} placeholder="https:// 或 http://localhost" disabled={!started}/></form></div>{started && <div className="browser-tabstrip" role="tablist" aria-label="浏览器标签页">{frame?.pages.map(page=><div className={`browser-tab ${(target||frame.target_id)===page.id?'active':''}`} key={page.id}><button role="tab" aria-selected={(target||frame.target_id)===page.id} title={page.url} onClick={()=>{setTarget(page.id);void operation('activate_page',{target_id:page.id}).catch(()=>{});}}>{page.title||page.url||'新标签页'}</button><button aria-label={`关闭网页 ${page.title||page.url||'新标签页'}`} onClick={()=>void operation('close_page',{target_id:page.id}).then(value=>{if(owner.current===c?.id&&value)setTarget((value as {target_id:string}).target_id)}).catch(()=>{})}><X size={12}/></button></div>)}<button className="iconbtn" aria-label="新建浏览器标签" onClick={()=>void operation('new_page').then(value=>{if(owner.current===c?.id&&value){setTarget((value as {target_id:string}).target_id);setUrl('');}}).catch(()=>{})}><Plus size={15}/></button></div>}</div>
    {!started ? <div className="browser-start"><Globe size={30}/><h3>同一个浏览器，共同检查结果</h3><p>使用本产品独立的 Chrome 会话。你看到的页面与 Agent 的浏览器工具连接同一实例，不读取日常浏览器的登录状态。</p>{!c ? <p>先创建或选择一个会话。</p> : c.thread_id && !c.config.browser_enabled ? <><p className="warning-box">当前 Codex Thread 创建时未启用浏览器工具。可以手动查看网页；Agent 控制需要新建同任务会话。</p><button className="textbtn outlined" onClick={() => void s.newConversation(c.task_id)}>新建同任务会话</button></> : null}<button className="textbtn primary" disabled={!c || !s.api.native || waiting} onClick={() => void start()}>{waiting ? '正在启动独立浏览器…' : '打开侧边浏览器'}</button>{!s.api.native && <p className="note">浏览器预览不启动 Chrome。请在桌面应用中验证真实浏览器。</p>}<p className="note">需要 Node.js 22、Chrome。首次 Agent 工具启动可能需要下载固定版本 Playwright MCP。</p></div> : <div className="browser-surface" ref={viewport} tabIndex={0} role="application" aria-label="远程浏览器画面，可点击并键盘输入" onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); void operation('text', { text: e.key }).catch(() => {}); } else if (['Enter','Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','a'].includes(e.key)) { e.preventDefault(); void operation('key', { key: e.key, modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0) }).catch(() => {}); } }} onPaste={e => { e.preventDefault(); void operation('text', { text: e.clipboardData.getData('text/plain') }).catch(() => {}); }} onWheel={e => { const box = e.currentTarget.getBoundingClientRect(); void operation('wheel', { x: (e.clientX - box.left)*(frame?.width||box.width)/box.width, y: (e.clientY - box.top)*(frame?.height||box.height)/box.height, dx: e.deltaX, dy: e.deltaY }).catch(() => {}); }} onClick={e => { const box = e.currentTarget.getBoundingClientRect(); e.currentTarget.focus(); if (frame) void operation('click', { x: (e.clientX - box.left) * frame.width / box.width, y: (e.clientY - box.top) * frame.height / box.height }).catch(() => {}); }}>{frame ? <img src={`data:image/jpeg;base64,${frame.data}`} alt={frame.title || '独立浏览器当前页面'} draggable={false}/> : <p className="note">正在读取真实浏览器画面…</p>}</div>}
    {started && <form className="browser-text-entry" onSubmit={e=>{e.preventDefault();if(inputText.trim())void operation('text',{text:inputText}).then(()=>setInputText('')).catch(()=>{});}}><input aria-label="向网页输入文字" value={inputText} onChange={e=>setInputText(e.target.value)} placeholder="先点击网页输入框，再在此输入中文"/><button className="textbtn outlined" disabled={!inputText}>输入</button></form>}
    {error && <p className="browser-error" role="alert">{error}</p>}{started && <div className="browser-footer"><MousePointer2 size={12}/>{c?.config.browser_enabled ? '你与 Agent 使用同一独立浏览器' : '当前为手动浏览；Agent 未连接此浏览器'}</div>}
  </aside>;
}
