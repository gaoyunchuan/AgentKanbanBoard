import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type DragEvent, type ClipboardEvent, type FormEvent } from 'react';
import type { BrowserFrame, BrowserInput, BrowserUpload } from './useSessionBrowser';

type Props = {
  frame?: BrowserFrame; upload: BrowserUpload; painted: boolean; rendered: (frame: BrowserFrame) => void;
  send: (input: BrowserInput) => boolean; operation: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  insertText: (text: string) => Promise<boolean>;
};
function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  // Chrome 运行于 Linux，把本机常用 Command 快捷键映射为 Control。
  return (event.altKey ? 1 : 0) | (event.ctrlKey || event.metaKey ? 2 : 0) | (event.shiftKey ? 8 : 0);
}
type BrowserKey = { key: string; code: string; windowsVirtualKeyCode: number };
const namedVirtualKeys: Record<string, number> = {
  Backspace: 8, Tab: 9, Clear: 12, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  Pause: 19, CapsLock: 20, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35,
  Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44,
  Insert: 45, Delete: 46, ContextMenu: 93, NumLock: 144, ScrollLock: 145,
};
const codeVirtualKeys: Record<string, number> = {
  Space: 32, NumpadEnter: 13, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109,
  NumpadDecimal: 110, NumpadDivide: 111, Semicolon: 186, Equal: 187, Comma: 188,
  Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219,
  Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226,
};
function browserKey(event: KeyboardEvent): BrowserKey {
  const key = event.key, code = event.code;
  let vk = namedVirtualKeys[key] ?? codeVirtualKeys[code];
  if (vk === undefined && /^Key[A-Z]$/.test(code)) vk = code.charCodeAt(3);
  if (vk === undefined && /^Digit[0-9]$/.test(code)) vk = code.charCodeAt(5);
  if (vk === undefined && /^Numpad[0-9]$/.test(code)) vk = 96 + Number(code.slice(6));
  if (vk === undefined && /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) vk = 111 + Number(key.slice(1));
  if (vk === undefined && /^[a-z0-9]$/i.test(key)) vk = key.toUpperCase().charCodeAt(0);
  return { key, code, windowsVirtualKeyCode: vk ?? (event.keyCode > 0 && event.keyCode < 256 ? event.keyCode : 0) };
}
type InputDiagnostic = { type: string; inputType: string; dataBytes: number; valueBytes: number; sent?: boolean };
type DiagnoseInput = (type: string, inputType: string, data: string | null, value: string, sent?: boolean) => void;
function useInputDiagnostics() {
  const enabled = import.meta.env.VITE_AKB_BROWSER_INPUT_DIAGNOSTICS === '1';
  const [events, setEvents] = useState<InputDiagnostic[]>([]);
  const record = useCallback<DiagnoseInput>((type, inputType, data, value, sent) => {
    if (!enabled) return;
    const encoder = new TextEncoder();
    const entry = { type, inputType, dataBytes: encoder.encode(data || '').byteLength, valueBytes: encoder.encode(value).byteLength, ...(sent === undefined ? {} : { sent }) };
    setEvents(previous => [...previous.slice(-11), entry]);
  }, [enabled]);
  return { enabled, events, record };
}
function useBrowserKeyboard({ send, operation, painted }: Pick<Props, 'send' | 'operation' | 'painted'>, deliverText: (text: string) => Promise<void>, diagnose: DiagnoseInput) {
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false), committed = useRef('');
  const pressed = useRef(new Map<string, BrowserKey>());
  useEffect(() => {
    const element = input.current;
    const beforeInput = (event: InputEvent) => {
      diagnose('beforeinput', event.inputType, event.data, element?.value || '');
      // 粘贴由 paste 接管；缺少剪贴板数据时保留默认插入，再从 input 取完整值。
      if (event.inputType === 'insertFromPaste') return;
      if (event.isComposing || composing.current || event.inputType === 'insertCompositionText') return;
      if (event.data && committed.current === event.data) { committed.current = ''; event.preventDefault(); return; }
      committed.current = '';
      if (event.data) { event.preventDefault(); void deliverText(event.data); }
    };
    element?.addEventListener('beforeinput', beforeInput);
    return () => element?.removeEventListener('beforeinput', beforeInput);
  }, [deliverText, diagnose]);
  const keyDown = (event: KeyboardEvent) => {
    // Command 只通过组合键的 modifiers 映射；独立转发会在本机粘贴期间按住远端 Control。
    if (event.key === 'Meta') return;
    // 退出、隐藏、最小化属于宿主APP，不能被映射成Linux Chrome的Control快捷键。
    if (event.metaKey && ['q', 'h', 'm'].includes(event.key.toLowerCase())) return;
    event.stopPropagation();
    if (!painted) { event.preventDefault(); return; }
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    committed.current = '';
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); void operation('copy_selection'); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    const key = browserKey(event);
    // 官方 stream 直接透传 CDP；Enter 需要文本才能触发默认换行和 keypress。
    const text = key.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey ? { text: '\r' } : {};
    if (send({ type: 'input_keyboard', eventType: 'keyDown', ...key, ...text, modifiers: modifiers(event) })) pressed.current.set(event.code || event.key, key);
  };
  const keyUp = (event: KeyboardEvent) => {
    if (event.key === 'Meta') return;
    event.stopPropagation();
    const identity = event.code || event.key, key = pressed.current.get(identity);
    // 只释放实际转发过的按键；输入法确认键和纯文本输入没有远端 keyDown。
    if (!key) return;
    pressed.current.delete(identity);
    event.preventDefault(); send({ type: 'input_keyboard', eventType: 'keyUp', ...key, modifiers: modifiers(event) });
  };
  const release = () => {
    const keys = [...pressed.current.values()]; pressed.current.clear();
    for (const key of keys) send({ type: 'input_keyboard', eventType: 'keyUp', ...key, modifiers: 0 });
  };
  return { input, keyDown, keyUp, release, forget: () => pressed.current.clear(), compositionStart: () => { composing.current = true; committed.current = ''; }, compositionEnd: (text: string) => {
    composing.current = false; committed.current = text;
    if (text) void deliverText(text);
    if (input.current) input.current.value = '';
  } };
}
function useNativePaste({ painted, upload }: Pick<Props, 'painted' | 'upload'>, deliverText: (text: string) => Promise<void>, diagnose: DiagnoseInput) {
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    const clipboard = event.clipboardData, text = clipboard?.getData('text/plain') || '';
    diagnose('paste', '', text, event.currentTarget.value);
    if (!painted) { diagnose('paste_branch', 'not_ready', text, event.currentTarget.value); event.preventDefault(); return; }
    const images = clipboard ? clipboardImages(clipboard) : [];
    diagnose('paste_branch', images.length ? 'image' : text ? 'text' : 'native_fallback', text, event.currentTarget.value);
    if (images.length) { event.preventDefault(); void upload.start(images, { kind: 'paste' }); return; }
    if (text) { event.preventDefault(); diagnose('send', 'paste', text, '', true); void deliverText(text); }
  };
  const inserted = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent, value = event.currentTarget.value;
    diagnose('input', native.inputType || '', native.data, value);
    if (native.isComposing) return;
    if (painted && native.inputType === 'insertFromPaste' && value) {
      diagnose('send', 'insertFromPaste', value, '', true); void deliverText(value);
    }
    event.currentTarget.value = '';
  };
  return { paste, inserted };
}
function FrameBuffers({ frame, rendered }: { frame?: BrowserFrame; rendered: (frame: BrowserFrame) => void }) {
  const first = useRef<HTMLImageElement>(null), second = useRef<HTMLImageElement>(null);
  const images = [first, second];
  const [visible, setVisible] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  const visibleRef = useRef(0), latest = useRef<BrowserFrame>();
  visibleRef.current = visible;
  useEffect(() => {
    if (!frame) { setPending(null); return; }
    latest.current = frame;
    const image = images[1 - visibleRef.current].current;
    if (!image) return;
    setPending(1 - visibleRef.current);
    image.dataset.seq = String(frame.seq);
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, [frame]);
  const loaded = (index: number) => {
    const value = latest.current, image = images[index].current;
    if (!value || !image || index === visibleRef.current || image.dataset.seq !== String(value.seq)) return;
    visibleRef.current = index; setVisible(index); setPending(null);
    rendered(value);
  };
  return <>{images.map((reference, index) => <img key={index} ref={reference}
    className={`browser-frame${visible === index ? ' visible' : ''}`}
    alt={pending === index ? '独立浏览器当前页面' : ''} draggable={false}
    onLoad={() => loaded(index)}/>)}{!frame && <div className="browser-frame-wait">正在连接真实浏览器画面…</div>}</>;
}
export function BrowserSurface(props: Props) {
  // 双层画面缓冲：旧帧保留到新帧解码完成再切换，滚动时不会出现空白帧。
  const { frame, rendered, send, operation, painted, upload, insertText } = props;
  const surface = useRef<HTMLDivElement>(null);
  const diagnostics = useInputDiagnostics();
  // CDP的char事件仅接受单个字符；整段文本走页面插入，短文本维持低成本字符事件。
  const deliverText = useCallback(async (text: string) => {
    if ([...text].length <= 1) { send({ type: 'input_keyboard', eventType: 'char', text }); return; }
    const sent = await insertText(text);
    diagnostics.record('send', 'insert_text', text, '', sent);
  }, [send, insertText, diagnostics.record]);
  const keyboard = useBrowserKeyboard({ send, operation, painted }, deliverText, diagnostics.record);
  const nativePaste = useNativePaste({ painted, upload }, deliverText, diagnostics.record);
  const dimensions = useRef('');
  const pressedButtons = useRef(new Map<string, { x: number; y: number }>());
  const releaseMouse = () => {
    const buttons = [...pressedButtons.current]; pressedButtons.current.clear();
    for (const [button, point] of buttons) send({ type: 'input_mouse', eventType: 'mouseReleased', ...point, button, clickCount: 1, modifiers: 0 });
  };
  const releaseInputs = () => { keyboard.release(); releaseMouse(); };
  useEffect(() => {
    window.addEventListener('blur', releaseInputs);
    return () => window.removeEventListener('blur', releaseInputs);
  }, [send]);
  useEffect(() => {
    // 断线后由代理处理原连接的释放确认；本地只丢弃记录，不向新流重放。
    if (!painted) { keyboard.forget(); pressedButtons.current.clear(); }
  }, [painted]);
  useEffect(() => {
    const element = surface.current; if (!element) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const box = element.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) return;
        const width = Math.max(240, Math.min(1600, Math.round(box.width))), height = Math.max(200, Math.min(1200, Math.round(box.height)));
        const size = `${width}x${height}`; if (size === dimensions.current) return;
        dimensions.current = size; void operation('resize', { width, height });
      }, 160);
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [operation]);
  const position = (event: { clientX: number; clientY: number }) => {
    const box = surface.current!.getBoundingClientRect();
    return { x: (event.clientX - box.left) * (frame?.metadata.deviceWidth || box.width) / Math.max(1, box.width), y: (event.clientY - box.top) * (frame?.metadata.deviceHeight || box.height) / Math.max(1, box.height) };
  };
  useEffect(() => {
    const element = surface.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element?.clientHeight || 500 : 1;
      send({ type: 'input_mouse', eventType: 'mouseWheel', ...position(event), deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiers(event) });
    };
    // React 的 wheel 默认使用被动监听，不能阻止工作台跟着网页滚动。
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => element?.removeEventListener('wheel', wheel);
  }, [send, frame]);
  const pointer = (event: PointerEvent, eventType: string) => {
    if (event.target === keyboard.input.current) { event.stopPropagation(); return; }
    if (eventType === 'mousePressed') { event.preventDefault(); keyboard.input.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); }
    const point = position(event), button = mouseButton(event, eventType);
    if (send({ type: 'input_mouse', eventType, ...point, button, clickCount: event.detail || 1, modifiers: modifiers(event) }) && eventType === 'mousePressed') pressedButtons.current.set(button, point);
    if (eventType === 'mouseMoved') for (const pressed of pressedButtons.current.keys()) pressedButtons.current.set(pressed, point);
    if (eventType === 'mouseReleased') pressedButtons.current.delete(button);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    if (painted) void upload.start(Array.from(event.dataTransfer.files), { kind: 'drop', ...position(event) });
  };
  return <div className="browser-surface" ref={surface} role="application" aria-label="远程浏览器画面，可点击并键盘输入" tabIndex={0}
    onFocus={event => { if (event.target === event.currentTarget) keyboard.input.current?.focus(); }}
    onPointerDown={event => pointer(event, 'mousePressed')} onPointerMove={event => pointer(event, 'mouseMoved')} onPointerUp={event => pointer(event, 'mouseReleased')}
    onPointerCancel={releaseInputs} onLostPointerCapture={releaseMouse}
    onContextMenu={event => event.preventDefault()} onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={drop}>
    <FrameBuffers frame={frame} rendered={rendered}/>
    <textarea className="browser-keyboard" ref={keyboard.input} aria-label="网页键盘输入" autoCapitalize="off" autoCorrect="off" spellCheck={false}
      onKeyDown={keyboard.keyDown} onKeyUp={keyboard.keyUp} onBlur={releaseInputs} onCompositionStart={keyboard.compositionStart} onCompositionEnd={event => keyboard.compositionEnd(event.data)}
      onInput={nativePaste.inserted} onPaste={nativePaste.paste}/>
    {diagnostics.enabled && <output className="browser-input-diagnostics" aria-label="浏览器输入诊断" aria-live="off">{JSON.stringify(diagnostics.events)}</output>}
  </div>;
}

function mouseButton(event: PointerEvent, eventType: string) {
  if (eventType === 'mouseMoved') return event.buttons & 1 ? 'left' : event.buttons & 2 ? 'right' : event.buttons & 4 ? 'middle' : 'none';
  return ['left', 'middle', 'right'][event.button] || 'none';
}

function clipboardImages(clipboard: DataTransfer) {
  const files = Array.from(clipboard.files || []).filter(file => file.type.startsWith('image/'));
  if (files.length) return files;
  return Array.from(clipboard.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => file !== null);
}
