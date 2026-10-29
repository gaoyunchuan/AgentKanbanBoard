import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type BrowserPage = { id: string; title: string; url: string; active: boolean };
export type BrowserState = {
  pages: BrowserPage[]; target_id: string; stream_url?: string;
  human_control: boolean; state_path?: string; input_interrupted?: boolean;
};
export type BrowserFrame = {
  type: 'frame'; seq: number; data: string;
  metadata: { deviceWidth: number; deviceHeight: number };
};
export type BrowserInput = Record<string, unknown> & { type: string };

export function useSessionBrowser(conversationId: string | undefined, native: boolean, visible: boolean, previouslyOpened = false) {
  const [state, setState] = useState<BrowserState>();
  const [started, setStarted] = useState(previouslyOpened);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const live = useRef(true), request = useRef(0), applied = useRef(0), pending = useRef(0);
  const visibleRef = useRef(visible), visibilityEpoch = useRef(0);
  visibleRef.current = visible;
  useEffect(() => { visibilityEpoch.current++; }, [visible]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const operation = useCallback(async (method: string, params: Record<string, unknown> = {}) => {
    if (!conversationId || !native) return;
    const sequence = ++request.current, epoch = visibilityEpoch.current;
    pending.current++;
    try {
      const value = await invoke<BrowserState>('chat_browser', { conversationId, method, params });
      if (!live.current || !visibleRef.current || epoch !== visibilityEpoch.current || sequence < applied.current) return;
      applied.current = sequence;
      if (value?.pages) setState(value);
      setError('');
      return value;
    } catch (cause) {
      if (live.current && visibleRef.current && epoch === visibilityEpoch.current && sequence >= applied.current) setError(String(cause));
    } finally { pending.current--; }
  }, [conversationId, native]);
  const start = useCallback(async (method = 'status') => {
    if (waiting) return;
    setWaiting(true);
    const value = await operation(method);
    if (live.current) { if (value) setStarted(true); setWaiting(false); }
  }, [operation, waiting]);
  useEffect(() => {
    if (!started || !visible) return;
    let cancelled = false;
    const tick = () => { if (!cancelled && !pending.current) void operation('status'); };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [started, visible, operation]);
  const stop = async () => { const value = await operation('stop'); if (value && live.current) { setStarted(false); setState(undefined); return true; } return false; };
  const prepare = async () => {
    if (waiting) return;
    setWaiting(true);
    const value = await operation('prepare');
    if (value && live.current) { const ready = await operation('status'); if (ready) setStarted(true); }
    if (live.current) setWaiting(false);
  };
  const takeControl = useCallback(() => setState(value => value && !value.human_control ? { ...value, human_control: true } : value), []);
  const stream = useBrowserStream(started && visible ? state : undefined, setStreamError, takeControl, operation);
  const upload = useBrowserUpload(conversationId, native, started && visible, state?.target_id, takeControl);
  return { state, started, waiting, error: error || streamError || stream.inputError, operation, start, stop, prepare, upload, ...stream };
}

function useBrowserStream(state: BrowserState | undefined, setError: (error: string) => void, takeControl: () => void, operation: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const [frame, setFrame] = useState<{ value: BrowserFrame; socket: WebSocket; target: string; url: string }>();
  const [connection, setConnection] = useState('未连接');
  const [painted, setPainted] = useState(false);
  const [inputError, setInputError] = useState('');
  const [reconnectKey, setReconnectKey] = useState(0);
  const current = useRef<WebSocket>();
  const target = state?.target_id, url = state?.stream_url;
  const latest = useRef(frame); latest.current = frame;
  useEffect(() => {
    setFrame(undefined); setPainted(false);
    if (!url || !target) { setConnection('未连接'); return; }
    let alive = true;
    setConnection('正在连接');
    const socket = new WebSocket(url); current.current = socket;
    socket.onopen = () => { if (alive) setConnection('等待画面'); };
    socket.onmessage = event => {
      if (!alive || current.current !== socket) return;
      try {
        const value = JSON.parse(event.data) as BrowserFrame;
        if (value.type === 'frame' && typeof value.data === 'string' && value.metadata) setFrame({ value, socket, target, url });
      } catch { setError('收到无法读取的浏览器画面，请重新连接。'); }
    };
    socket.onerror = () => { if (alive) { setError('浏览器画面连接失败，请重新连接。'); setConnection('连接失败'); setPainted(false); } };
    socket.onclose = () => { if (alive) { setConnection('已断开'); setPainted(false); setFrame(undefined); } };
    return () => { alive = false; socket.close(); if (current.current === socket) current.current = undefined; };
  }, [url, target, reconnectKey, setError]);
  const rendered = (value: BrowserFrame) => {
    const socket = current.current;
    // onLoad 后留出一次绘制机会，再确认这张仍属于当前连接的帧。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!socket || socket !== current.current || latest.current?.socket !== socket || latest.current.value !== value || socket.readyState !== 1) return;
      socket.send(JSON.stringify({ type: 'ack', seq: value.seq }));
      setError('');
      setPainted(true); setConnection('实时连接');
    }));
  };
  const send = (input: BrowserInput) => {
    if (!painted || !current.current || current.current.readyState !== 1) return false;
    const payload = JSON.stringify(input), bytes = new TextEncoder().encode(payload).byteLength;
    if (bytes > 16 * 1024) { setInputError('单次输入超过 16 KiB，请分段输入；本次内容未发送。'); return false; }
    if (current.current.bufferedAmount + bytes > 512 * 1024) {
      setError('浏览器输入连接积压，已断开；请重新连接并检查页面，本次输入不会自动重发。');
      setPainted(false); setFrame(undefined); setConnection('已断开'); current.current.close();
      return false;
    }
    current.current.send(payload); takeControl();
    if (input.type === 'input_keyboard' && input.eventType !== 'keyUp') setInputError('');
    return true;
  };
  const activeFrame = frame && frame.socket === current.current && frame.target === target && frame.url === url ? frame.value : undefined;
  // CDP的char事件只接受单个字符；整段粘贴改走页面插入，并在这里复用16KiB与绘图时机边界。
  const insertText = async (text: string) => {
    if (!painted || !target) return false;
    if (new TextEncoder().encode(text).byteLength > 16 * 1024) { setInputError('单次输入超过 16 KiB，请分段输入；本次内容未发送。'); return false; }
    takeControl();
    try {
      // operation 失败时已写入连接错误并返回空值，这里只负责确认是否真正插入。
      const value = await operation('insert_text', { target_id: target, text });
      if (value === undefined) return false;
      setInputError(''); return true;
    } catch (cause) { setInputError(`粘贴文本未能送入网页：${String(cause)}`); return false; }
  };
  return { frame: activeFrame, painted: painted && Boolean(activeFrame), connection, rendered, send, insertText, inputError, reconnect: () => { setInputError(''); setReconnectKey(value => value + 1); } };
}

export type UploadDestination = { kind: 'drop' | 'paste' | 'input'; x?: number; y?: number };
type UploadProgress = { busy: boolean; name: string; total: number; received: number; message: string; error: string };
type UploadRun = { cancelled: boolean; opened: boolean; uploaded: boolean };
type UploadReply = { uploading?: boolean; uploaded?: boolean; received?: number; error?: string };
export type BrowserUpload = UploadProgress & {
  start: (files: File[], destination: UploadDestination) => Promise<void>;
  cancel: () => void;
};
const uploadChunkSize = 64 * 1024;
const uploadLimit = 64 * 1024 * 1024;
const uploadCancelled = Symbol('upload-cancelled');

async function transferUploadChunks(file: File, run: UploadRun, call: (method: string, params: Record<string, unknown>) => Promise<UploadReply>, progress: (received: number) => void) {
  for (let offset = 0; offset < file.size; offset += uploadChunkSize) {
    if (run.cancelled) throw uploadCancelled;
    const end = Math.min(file.size, offset + uploadChunkSize);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    if (run.cancelled) throw uploadCancelled;
    const reply = await call('upload_chunk', { bytes: Array.from(bytes) });
    if (run.cancelled) throw uploadCancelled;
    if (reply.received !== end) throw new Error(reply.error || '浏览器未确认接收完整分块，上传已停止。');
    progress(end);
  }
}
function useBrowserUpload(conversationId: string | undefined, native: boolean, visible: boolean, targetId: string | undefined, takeControl: () => void): BrowserUpload {
  const [progress, setProgress] = useState<UploadProgress>({ busy: false, name: '', total: 0, received: 0, message: '', error: '' });
  const current = useRef<UploadRun>();
  const live = useRef(true);
  const cancel = useCallback(() => {
    if (!current.current) return;
    current.current.cancelled = true;
    setProgress(value => ({ ...value, message: '正在取消上传…' }));
  }, []);
  useEffect(() => { live.current = true; return () => { live.current = false; if (current.current) current.current.cancelled = true; }; }, []);
  useEffect(() => { if (!visible) cancel(); return () => { if (current.current) current.current.cancelled = true; }; }, [visible, targetId, cancel]);
  const start = async (files: File[], destination: UploadDestination) => {
    if (current.current || !native || !visible || !conversationId || !targetId) return;
    const file = files[0];
    const error = files.length !== 1 ? '一次只能上传一个文件，请逐个拖入或粘贴。' : file.size > uploadLimit ? '文件超过 64 MiB，请选择更小的文件。' : '';
    if (error) { setProgress(value => ({ ...value, error, message: '' })); return; }
    const run: UploadRun = { cancelled: false, opened: false, uploaded: false }; current.current = run;
    const update = (patch: Partial<UploadProgress>) => { if (live.current && current.current === run) setProgress(value => ({ ...value, ...patch })); };
    const call = (method: string, params: Record<string, unknown> = {}) => invoke<UploadReply>('chat_browser', { conversationId, method, params });
    setProgress({ busy: true, name: file.name, total: file.size, received: 0, message: '正在上传…', error: '' });
    takeControl();
    try {
      const begin = await call('upload_begin', { name: file.name, size: file.size });
      if (begin.uploading !== true) throw new Error(begin.error || '浏览器未确认开始上传。');
      run.opened = true;
      if (run.cancelled) throw uploadCancelled;
      await transferUploadChunks(file, run, call, received => update({ received }));
      if (run.cancelled) throw uploadCancelled;
      update({ message: '正在交给网页…' });
      const finish = await call('upload_finish', { ...destination, target_id: targetId });
      if (finish.uploaded !== true) throw new Error(finish.error || '网页未确认接收文件，请检查页面后重试。');
      run.uploaded = true;
      if (run.cancelled) throw uploadCancelled;
      update({ message: '上传完成' });
    } catch (cause) {
      update(cause === uploadCancelled ? { message: run.uploaded ? '文件已发送，请检查原网页。' : '上传已取消' } : { message: '', error: String(cause) });
    } finally {
      if (run.opened && (!run.uploaded || run.cancelled)) {
        try { await call('upload_cancel'); } catch (cause) { update({ error: `清理未完成的上传失败：${String(cause)}` }); }
      }
      update({ busy: false });
      if (current.current === run) current.current = undefined;
    }
  };
  return { ...progress, start, cancel };
}
