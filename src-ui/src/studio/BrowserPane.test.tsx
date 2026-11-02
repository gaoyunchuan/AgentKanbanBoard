import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { BrowserPane } from './BrowserPane';
import { StudioContext, type StudioState } from './context';
import { defaultConfig, type Conversation } from './model';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
class BrowserSocket {
  static instances: BrowserSocket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(public url: string) { BrowserSocket.instances.push(this); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  frame(seq = 1) { this.onmessage?.({ data: JSON.stringify({ type: 'frame', seq, data: 'AA==', metadata: { deviceWidth: 600, deviceHeight: 500 } }) } as MessageEvent); }
}
const conversation: Conversation = { id: 'c', task_id: 't', title: 'test', mode: 'manual', project_id: 'p', config: defaultConfig('/tmp'), runtime_status: 'idle', pinned: false, closed: false, revision: 0, created_at: '', updated_at: '' };
function fixture() {
  let received = 0;
  let pages = [{ id: 'one', title: 'First page', url: 'about:blank', active: true }], target = 'one';
  vi.mocked(invoke).mockImplementation(async (_name, args) => {
    const value = args as { conversationId: string; method: string; params: { target_id?: string; bytes?: number[] } };
    if (value.method === 'upload_begin') { received = 0; return { uploading: true }; }
    if (value.method === 'upload_chunk') { received += value.params.bytes!.length; return { received }; }
    if (value.method === 'upload_finish') return { uploaded: true };
    if (value.method === 'upload_cancel') return { cancelled: true };
    if (value.method === 'new_page') { pages.push({ id: 'two', title: 'Second page', url: 'about:blank', active: true }); target = 'two'; }
    if (value.method === 'close_page') { pages = pages.filter(p => p.id !== value.params.target_id); target = pages[0].id; }
    if (value.method === 'activate_page') target = value.params.target_id!;
    return { pages, target_id: target, stream_url: `ws://127.0.0.1/${value.conversationId}/${target}`, human_control: value.method === 'copy_selection', state_path: '/app/state', input_interrupted: false };
  });
  return { api: { native: true }, conversation, command: vi.fn(), newConversation: vi.fn() } as unknown as StudioState;
}
function view(state: StudioState, active = true) { return <StudioContext.Provider value={state}><BrowserPane active={active}/></StudioContext.Provider>; }
async function start(state = fixture()) {
  const result = render(view(state));
  await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
  await waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
  return { ...result, state, socket: BrowserSocket.instances[0] };
}
async function paint(socket: BrowserSocket) {
  act(() => socket.frame());
  fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
  await waitFor(() => expect(socket.sent).toContainEqual({ type: 'ack', seq: 1 }));
}
function transferFile(name = 'drop.bin', size = 65539, type = 'application/octet-stream') {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const file = new File([bytes], name, { type });
  const slice = vi.spyOn(file, 'slice').mockImplementation((start = 0, end = size) => ({ arrayBuffer: async () => bytes.slice(start, end).buffer } as Blob));
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(() => { throw new Error('不得一次读取整个文件'); }) });
  return { file, slice, bytes };
}
function dropFiles(element: HTMLElement, files: File[], clientX = 0, clientY = 0) {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  fireEvent(element, event);
}
function transfers(method: string) {
  return vi.mocked(invoke).mock.calls.map(([, value]) => value as { conversationId: string; method: string; params: Record<string, unknown> }).filter(value => value.method === method);
}
function insertedTexts() {
  return transfers('insert_text').map(value => value.params.text);
}
beforeEach(() => {
  BrowserSocket.instances = [];
  vi.stubGlobal('WebSocket', BrowserSocket);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('会话浏览器实时画面', () => {
  it('窗口缩放只改变原生画面位置时也更新坐标，隐藏和卸载后不再上报', async () => {
    const rect = vi.fn(), hide = vi.fn();
    vi.stubGlobal('akb', { browser: true, rect, hide });
    let box = { x: 500, y: 100, width: 600, height: 500 };
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => box as DOMRect);
    try {
      const state = fixture(), ui = render(view(state));
      await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
      await screen.findByLabelText('原生浏览器画面');
      expect(rect).toHaveBeenLastCalledWith({ conversationId: 'c', rect: box });
      // 固定宽右栏在横向扩窗后只移动 x，ResizeObserver 不会因位置变化回调。
      box = { ...box, x: 1000 };
      fireEvent(window, new Event('resize'));
      expect(rect).toHaveBeenLastCalledWith({ conversationId: 'c', rect: box });
      box = { x: 300, y: 100, width: 400, height: 350 };
      fireEvent(window, new Event('resize'));
      expect(rect).toHaveBeenLastCalledWith({ conversationId: 'c', rect: box });
      ui.rerender(view(state, false));
      rect.mockClear();
      fireEvent(window, new Event('resize'));
      expect(rect).not.toHaveBeenCalled();
      expect(hide).toHaveBeenCalled();
      ui.rerender(view(state));
      await screen.findByLabelText('原生浏览器画面');
      expect(rect).toHaveBeenLastCalledWith({ conversationId: 'c', rect: box });
      ui.unmount();rect.mockClear();
      fireEvent(window, new Event('resize'));
      expect(rect).not.toHaveBeenCalled();
    } finally { measure.mockRestore(); }
  });
  it('按真实 target 新建、选择和关闭标签，切页立即关闭旧流', async () => {
    const { socket } = await start();
    await userEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }));
    await screen.findByRole('tab', { name: 'Second page' });
    expect(socket.closed).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'First page' }));
    expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'activate_page', params: { target_id: 'one' } }));
    await userEvent.click(screen.getByRole('button', { name: '关闭网页 Second page' }));
    expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'close_page', params: { target_id: 'two' } }));
  });
  it('收到帧不提前ACK，画面加载前不允许输入', async () => {
    const { socket } = await start();
    act(() => socket.frame());
    expect(socket.sent).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText('网页键盘输入'), { key: 'Enter' });
    expect(socket.sent).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText('网页键盘输入'), { key: 'c', metaKey: true });
    expect(invoke).not.toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'copy_selection' }));
    fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
    await waitFor(() => expect(socket.sent).toContainEqual({ type: 'ack', seq: 1 }));
  });
  it('新帧解码完成前保留旧画面，切换过程始终有一层可见', async () => {
    const { socket } = await start(); await paint(socket);
    const visibleCount = () => document.querySelectorAll('.browser-frame.visible').length;
    expect(visibleCount()).toBe(1);
    act(() => socket.frame(2));
    expect(visibleCount()).toBe(1);
    fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
    await waitFor(() => expect(socket.sent).toContainEqual({ type: 'ack', seq: 2 }));
    expect(visibleCount()).toBe(1);
  });
  it('切换会话关闭旧流并忽略迟到帧和操作结果', async () => {
    const { state, rerender, socket } = await start();
    await paint(socket);
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async () => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }));
    rerender(view({ ...state, conversation: { ...conversation, id: 'other' } }));
    act(() => { socket.frame(2); finish({ pages: [{ id: 'late', title: 'Late', url: '' }], target_id: 'late' }); });
    expect(socket.closed).toBe(true);
    expect(screen.queryByAltText('独立浏览器当前页面')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Late' })).not.toBeInTheDocument();
  });
  it('隐藏面板断开流，恢复时重新获取连接', async () => {
    const { state, rerender, socket } = await start();
    rerender(view(state, false));
    expect(socket.closed).toBe(true);
    rerender(view(state, true));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(2));
  });
  it('中文只在组合完成发送一次，普通字符经beforeinput发送，IME确认Enter不发到网页', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'n', code: 'KeyN', isComposing: true });
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, data: 'ni', inputType: 'insertCompositionText', isComposing: true }));
    fireEvent.compositionEnd(input, { data: '你好' });
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, data: '你好', inputType: 'insertText' }));
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, data: 'a', inputType: 'insertText' }));
    await waitFor(() => expect(insertedTexts()).toEqual(['你好']));
    expect(socket.sent.filter(message => message.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'char', text: 'a' },
    ]);
  });
  it('隐藏期间挂起的操作在重新展开后仍不能覆盖新状态', async () => {
    const { state, rerender } = await start();
    let finish!: (value: unknown) => void;
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => (args as { method: string }).method === 'new_page'
      ? new Promise(resolve => { finish = resolve; }) : original(name, args, options));
    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }));
    rerender(view(state, false)); rerender(view(state, true));
    await act(async () => finish({ pages: [{ id: 'late', title: 'Late hidden operation', url: '', active: true }], target_id: 'late', stream_url: 'ws://127.0.0.1/late' }));
    expect(screen.queryByRole('tab', { name: 'Late hidden operation' })).not.toBeInTheDocument();
  });
  it('隐藏期间停止元数据轮询，关闭浏览器调用stop且不修改会话配置', async () => {
    const { state, rerender } = await start();
    vi.useFakeTimers();
    rerender(view(state, false));
    const calls = vi.mocked(invoke).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3200); });
    expect(invoke).toHaveBeenCalledTimes(calls);
    vi.useRealTimers();
    rerender(view(state, true));
    await userEvent.click(screen.getByRole('button', { name: '关闭浏览器保留登录状态' }));
    expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'stop', conversationId: 'c' }));
    expect(await screen.findByRole('button', { name: '打开侧边浏览器' })).toBeInTheDocument();
    expect(state.command).not.toHaveBeenCalled();
  });
  it('粘贴只发送文本，复制读取真实选区，并可把控制权交回Agent', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.keyDown(input, { key: 'v', code: 'KeyV', metaKey: true });
    fireEvent.paste(input, { clipboardData: { getData: () => '粘贴内容' } });
    fireEvent.keyDown(input, { key: 'c', code: 'KeyC', metaKey: true });
    await waitFor(() => expect(insertedTexts()).toEqual(['粘贴内容']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'copy_selection' }));
    await userEvent.click(screen.getByRole('button', { name: '交给 Agent' }));
    expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'release_control', params: { target_id: 'one' } }));
  });
  it('切回已经打开的会话自动复连，未打开和主动关闭的会话保持打开按钮', async () => {
    const { state, rerender, socket } = await start();
    const other = { ...state, conversation: { ...conversation, id: 'other' } };
    rerender(view(other));
    expect(socket.closed).toBe(true);
    expect(screen.getByRole('button', { name: '打开侧边浏览器' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(2));
    rerender(view(state));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(3));
    expect(BrowserSocket.instances[2].url).toContain('/c/');
    await userEvent.click(screen.getByRole('button', { name: '关闭浏览器保留登录状态' }));
    rerender(view(other)); rerender(view(state));
    expect(screen.getByRole('button', { name: '打开侧边浏览器' })).toBeInTheDocument();
  });
  it('只记住最近四个成功打开的会话，历史会话不会无界自动启动', async () => {
    const { state, rerender } = await start();
    for (const id of ['two', 'three', 'four', 'five']) {
      rerender(view({ ...state, conversation: { ...conversation, id } }));
      await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'status', conversationId: id })));
    }
    rerender(view(state));
    expect(screen.getByRole('button', { name: '打开侧边浏览器' })).toBeInTheDocument();
  });
  it('指针拖选、滚轮和快捷键使用实际画面坐标及Linux修饰键', async () => {
    const { socket } = await start(); await paint(socket);
    const surface = screen.getByRole('application');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 300, height: 250 } as DOMRect);
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 50, button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 70, clientY: 80, button: 0, buttons: 1, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 70, clientY: 80, button: 0, buttons: 0, pointerId: 1 });
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 40, clientY: 50, deltaX: 3, deltaY: 100 });
    fireEvent(surface, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.keyDown(input, { key: 'a', code: 'KeyA', metaKey: true });
    fireEvent.keyUp(input, { key: 'a', code: 'KeyA', metaKey: true });
    expect(socket.sent.filter(value => value.type === 'input_mouse')).toEqual([
      { type: 'input_mouse', eventType: 'mousePressed', x: 60, y: 60, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'input_mouse', eventType: 'mouseMoved', x: 120, y: 120, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'input_mouse', eventType: 'mouseReleased', x: 120, y: 120, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'input_mouse', eventType: 'mouseWheel', x: 60, y: 60, deltaX: 3, deltaY: 100, modifiers: 0 },
    ]);
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
    ]);
  });
  it.each(['q', 'h', 'm'])('浏览器输入聚焦时Command+%s仍交给桌面应用', async key => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    expect(fireEvent.keyDown(input, { key, code: `Key${key.toUpperCase()}`, metaKey: true })).toBe(true);
    fireEvent.keyUp(input, { key, code: `Key${key.toUpperCase()}`, metaKey: true });
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('上传和下载入口只传当前target，不传主机任意文件路径', async () => {
    await start();
    await userEvent.click(screen.getByRole('button', { name: '上传文件到网页' }));
    await userEvent.click(screen.getByRole('button', { name: '打开浏览器下载目录' }));
    expect(invoke).toHaveBeenCalledWith('chat_browser', { conversationId: 'c', method: 'pick_upload', params: { target_id: 'one' } });
    expect(invoke).toHaveBeenCalledWith('chat_browser', { conversationId: 'c', method: 'open_downloads', params: { target_id: 'one' } });
  });
  it('等待一次真实绘制机会再ACK，期间被新帧替换的旧帧不确认', async () => {
    const { socket } = await start();
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; });
    act(() => socket.frame(1));
    fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
    act(() => callbacks.shift()!(0));
    expect(socket.sent).toEqual([]);
    act(() => socket.frame(2));
    act(() => callbacks.shift()!(16));
    expect(socket.sent).toEqual([]);
    fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
    act(() => callbacks.shift()!(32)); act(() => callbacks.shift()!(48));
    expect(socket.sent).toEqual([{ type: 'ack', seq: 2 }]);
  });
  it('文件拖入按64KiB串行读取并上传，完成时使用真实画面坐标及target', async () => {
    const { socket } = await start(); await paint(socket);
    const surface = screen.getByRole('application');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 300, height: 250 } as DOMRect);
    const { file, slice, bytes } = transferFile();
    dropFiles(surface, [file], 40, 50);
    await waitFor(() => expect(transfers('upload_finish')).toHaveLength(1));
    expect(transfers('upload_begin')[0]).toEqual({ conversationId: 'c', method: 'upload_begin', params: { name: 'drop.bin', size: 65539 } });
    expect(slice.mock.calls).toEqual([[0, 65536], [65536, 65539]]);
    expect(transfers('upload_chunk').map(value => value.params.bytes)).toEqual([Array.from(bytes.slice(0, 65536)), Array.from(bytes.slice(65536))]);
    expect(transfers('upload_finish')[0].params).toEqual({ kind: 'drop', x: 60, y: 60, target_id: 'one' });
    await waitFor(() => expect(screen.getByText('上传完成')).toHaveTextContent('drop.bin'));
  });
  it('图片剪贴板优先于文字，重复files与items只上传一次，普通文本仍直接输入', async () => {
    const { socket } = await start(); await paint(socket);
    const { file } = transferFile('image.png', 3, 'image/png');
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.paste(input, { clipboardData: { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '不重复发文字' } });
    await waitFor(() => expect(transfers('upload_finish')).toHaveLength(1));
    expect(transfers('upload_finish')[0].params).toEqual({ kind: 'paste', target_id: 'one' });
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    fireEvent.paste(input, { clipboardData: { getData: () => '普通文本' } });
    await waitFor(() => expect(insertedTexts()).toContain('普通文本'));
  });
  it('首帧前拒绝文件拖入和图片粘贴，多个文件或超过64MiB在上传前明确拒绝', async () => {
    const { socket } = await start(); const { file } = transferFile('image.png', 3, 'image/png');
    dropFiles(screen.getByRole('application'), [file]);
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { files: [file], getData: () => '' } });
    expect(transfers('upload_begin')).toHaveLength(0);
    await paint(socket);
    dropFiles(screen.getByRole('application'), [file, file]);
    expect(await screen.findByRole('alert')).toHaveTextContent('一次只能上传一个文件');
    const oversized = new File(['x'], 'large.bin'); Object.defineProperty(oversized, 'size', { value: 67108865 });
    dropFiles(screen.getByRole('application'), [oversized]);
    expect(await screen.findByRole('alert')).toHaveTextContent('64 MiB');
    expect(transfers('upload_begin')).toHaveLength(0);
  });
  it.each(['取消', '隐藏', '切换会话'])('%s时等待在途分块结束再清理，不发送完成也不串到其他owner', async action => {
    const { state, rerender, socket } = await start(); await paint(socket);
    const original = vi.mocked(invoke).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => (args as { method: string }).method === 'upload_chunk'
      ? new Promise(resolve => { finish = resolve; }) : original(name, args, options));
    const { file } = transferFile();
    dropFiles(screen.getByRole('application'), [file]);
    await waitFor(() => expect(transfers('upload_chunk')).toHaveLength(1));
    expect(screen.getByRole('button', { name: '取消文件上传' })).toBeInTheDocument();
    if (action === '取消') await userEvent.click(screen.getByRole('button', { name: '取消文件上传' }));
    if (action === '隐藏') rerender(view(state, false));
    if (action === '切换会话') rerender(view({ ...state, conversation: { ...conversation, id: 'other' } }));
    await act(async () => finish({ received: 65536 }));
    await waitFor(() => expect(transfers('upload_cancel')).toHaveLength(1));
    expect(transfers('upload_cancel')[0].conversationId).toBe('c');
    expect(transfers('upload_chunk')).toHaveLength(1); expect(transfers('upload_finish')).toHaveLength(0);
    expect(screen.queryByText(/上传完成/)).not.toBeInTheDocument();
  });
  it('网页拒绝图片粘贴时呈现服务端真实错误并清理临时分块', async () => {
    const { socket } = await start(); await paint(socket);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => {
      if ((args as { method: string }).method === 'upload_finish') throw new Error('此网页不支持图片粘贴');
      return original(name, args, options);
    });
    const { file } = transferFile('image.png', 3, 'image/png');
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { files: [file], getData: () => '' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('此网页不支持图片粘贴');
    await waitFor(() => expect(transfers('upload_cancel')).toHaveLength(1));
    expect(screen.queryByText(/上传完成/)).not.toBeInTheDocument();
  });
  it.each(['upload_chunk', 'upload_finish'])('%s没有确认完整接收时不宣称成功，并清理本次上传', async method => {
    const { socket } = await start(); await paint(socket);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => (args as { method: string }).method === method
      ? { received: 0, uploaded: false } : original(name, args, options));
    const { file } = transferFile('test.bin', 3);
    dropFiles(screen.getByRole('application'), [file]);
    expect(await screen.findByRole('alert')).toHaveTextContent('未确认');
    await waitFor(() => expect(transfers('upload_cancel')).toHaveLength(1));
    expect(screen.queryByText('上传完成')).not.toBeInTheDocument();
    if (method === 'upload_chunk') expect(transfers('upload_finish')).toHaveLength(0);
  });
  it('网页接收已在途时取消，不谎称能撤回已发给原网页的文件', async () => {
    const { socket } = await start(); await paint(socket);
    const original = vi.mocked(invoke).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => (args as { method: string }).method === 'upload_finish'
      ? new Promise(resolve => { finish = resolve; }) : original(name, args, options));
    const { file } = transferFile('test.bin', 3); dropFiles(screen.getByRole('application'), [file]);
    await waitFor(() => expect(transfers('upload_finish')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: '取消文件上传' }));
    await act(async () => finish({ uploaded: true }));
    expect(await screen.findByText('文件已发送，请检查原网页。')).toBeInTheDocument();
    expect(screen.queryByText('上传已取消')).not.toBeInTheDocument();
  });
  it('鼠标选词完成中文后，第一次业务Enter正常传给网页', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.compositionStart(input);
    fireEvent.compositionEnd(input, { data: '你好' });
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, data: '你好', inputType: 'insertText' }));
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    fireEvent.keyUp(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() => expect(insertedTexts()).toEqual(['你好']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', modifiers: 0 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    ]);
  });
  it('输入法确认Enter早于compositionEnd时不会发送多余按键', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', isComposing: true });
    fireEvent.compositionEnd(input, { data: '中文' });
    fireEvent.keyUp(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(insertedTexts()).toEqual(['中文']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('快捷键修饰键先松开时，仍释放之前已转发的字符键', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.keyDown(input, { key: 'a', code: 'KeyA', metaKey: true });
    fireEvent.keyUp(input, { key: 'a', code: 'KeyA', metaKey: false });
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
    ]);
  });
  it('辅助功能聚焦隐藏输入控件不转发远端鼠标，真实画面点击仍正常定位', async () => {
    const { socket } = await start(); await paint(socket);
    const surface = screen.getByRole('application'), input = screen.getByLabelText('网页键盘输入');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100, width: 300, height: 250 } as DOMRect);
    fireEvent.pointerDown(input, { clientX: 101, clientY: 101, button: 0, buttons: 1 });
    fireEvent.pointerUp(input, { clientX: 101, clientY: 101, button: 0, buttons: 0 });
    expect(socket.sent.filter(value => value.type === 'input_mouse')).toEqual([]);
    fireEvent.pointerDown(surface, { clientX: 150, clientY: 150, button: 0, buttons: 1 });
    expect(socket.sent).toContainEqual({ type: 'input_mouse', eventType: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1, modifiers: 0 });
    expect(document.activeElement).toBe(input);
  });
  it.each(['textarea', 'window'])('%s失焦只释放已转发的按键与鼠标，不重复释放或在重新聚焦时重放', async owner => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入'), surface = screen.getByRole('application');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 250 } as DOMRect);
    input.focus();
    fireEvent.keyDown(input, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    fireEvent.pointerDown(surface, { clientX: 30, clientY: 40, button: 0, buttons: 1 });
    fireEvent.pointerMove(surface, { clientX: 45, clientY: 55, button: -1, buttons: 1 });
    if (owner === 'textarea') fireEvent.blur(input); else fireEvent(window, new Event('blur'));
    expect(socket.sent).toContainEqual({ type: 'input_keyboard', eventType: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
    expect(socket.sent).toContainEqual({ type: 'input_mouse', eventType: 'mouseReleased', x: 90, y: 110, button: 'left', clickCount: 1, modifiers: 0 });
    const after = [...socket.sent];
    fireEvent.blur(input); fireEvent(window, new Event('blur')); fireEvent(window, new Event('focus'));
    expect(socket.sent).toEqual(after);
  });
  it.each([[2, 2, 'right'], [4, 1, 'middle']] as const)('拖动buttons=%s时使用位图保留鼠标%s对应的%s键', async (buttons, button, expected) => {
    const { socket } = await start(); await paint(socket);
    const surface = screen.getByRole('application');
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 250 } as DOMRect);
    fireEvent.pointerDown(surface, { clientX: 30, clientY: 40, button, buttons });
    fireEvent.pointerMove(surface, { clientX: 45, clientY: 55, button: -1, buttons });
    expect(socket.sent).toContainEqual({ type: 'input_mouse', eventType: 'mouseMoved', x: 90, y: 110, button: expected, clickCount: 1, modifiers: 0 });
  });
  it('断线重连清除旧按键和鼠标记录，不把旧连接动作释放或重放到新流', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入'), surface = screen.getByRole('application');
    fireEvent.keyDown(input, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    fireEvent.pointerDown(surface, { clientX: 30, clientY: 40, button: 0, buttons: 1 });
    act(() => { socket.readyState = 3; socket.onclose?.(); });
    await userEvent.click(screen.getByRole('button', { name: '重新连接浏览器画面' }));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(2));
    const next = BrowserSocket.instances[1]; await paint(next);
    fireEvent(window, new Event('blur')); fireEvent(window, new Event('focus'));
    expect(next.sent).toEqual([{ type: 'ack', seq: 1 }]);
  });
  it('首次启动失败后的错误区重试走restart，普通首次打开仍走status', async () => {
    const state = fixture(), original = vi.mocked(invoke).getMockImplementation()!;
    let failed = false;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => {
      if (!failed && (args as { method: string }).method === 'status') { failed = true; throw new Error('初始化失败且清理未确认'); }
      return original(name, args, options);
    });
    render(view(state));
    await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('初始化失败且清理未确认');
    expect(transfers('status')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(transfers('restart')).toHaveLength(1));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
  });
  it('元数据成功不清除画面流错误，真实新帧绘制后才清除', async () => {
    const { socket } = await start();
    act(() => socket.onerror?.());
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器画面连接失败');
    const metadataCalls = transfers('status').length;
    await waitFor(() => expect(transfers('status').length).toBeGreaterThan(metadataCalls), { timeout: 1800 });
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器画面连接失败');
    await userEvent.click(screen.getByRole('button', { name: '重新连接浏览器画面' }));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(2));
    await paint(BrowserSocket.instances[1]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.skipIf(process.platform !== 'darwin')('真实WebKit中错误显示与清除不改变浏览器viewport尺寸', async () => {
    const { socket } = await start(); act(() => socket.onerror?.());
    const pane = screen.getByLabelText('侧边浏览器').outerHTML;
    const css = readFileSync('src/studio/studio.css', 'utf8') + readFileSync('src/studio/browser.css', 'utf8');
    const html = `<!doctype html><meta charset=utf-8><style>*{box-sizing:border-box}body{margin:0}${css}</style><div class=studio style="height:800px;display:flex"><aside class=right-dock style="width:302px;height:800px;max-width:none"><div class=dock-content>${pane}</div></aside></div><script>const s=document.querySelector('.browser-surface'),e=document.querySelector('.browser-error');const size=()=>({width:s.getBoundingClientRect().width,height:s.getBoundingClientRect().height});e.style.display='none';const before=size();e.style.display='';const visible=size();const errorHeight=e.getBoundingClientRect().height;e.style.display='none';window.webkit.messageHandlers.result.postMessage(JSON.stringify({before,visible,after:size(),errorHeight}));</script>`;
    const encoded = Buffer.from(html).toString('base64');
    const script = `import AppKit
import WebKit
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
final class Handler: NSObject, WKScriptMessageHandler {func userContentController(_ c: WKUserContentController,didReceive message: WKScriptMessage){print(message.body);exit(0)}}
let config=WKWebViewConfiguration(), handler=Handler()
config.userContentController.add(handler,name:"result")
let view=WKWebView(frame:NSRect(x:0,y:0,width:302,height:800),configuration:config)
let window=NSWindow(contentRect:NSRect(x:-10000,y:-10000,width:302,height:800),styleMask:[.borderless],backing:.buffered,defer:false)
window.contentView=view;window.orderFront(nil)
view.loadHTMLString(String(data:Data(base64Encoded:"${encoded}")!,encoding:.utf8)!,baseURL:nil)
DispatchQueue.main.asyncAfter(deadline:.now()+15){exit(1)}
app.run()
`;
    const result = spawnSync('/usr/bin/swift', ['-'], { input: script, encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const measured = JSON.parse(result.stdout.trim());
    expect(measured.errorHeight).toBeGreaterThan(0);
    expect(measured.visible).toEqual(measured.before);
    expect(measured.after).toEqual(measured.before);
  }, 25000);
  it.each([
    { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    { key: 'Backspace', code: 'Backspace', vk: 8 },
    { key: 'Tab', code: 'Tab', vk: 9 },
    { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    { key: 'Delete', code: 'Delete', vk: 46 },
    { key: 'Home', code: 'Home', vk: 36 },
    { key: 'End', code: 'End', vk: 35 },
    { key: 'PageUp', code: 'PageUp', vk: 33 },
    { key: 'PageDown', code: 'PageDown', vk: 34 },
    { key: 'Escape', code: 'Escape', vk: 27 },
    { key: 'a', code: 'KeyA', vk: 65, metaKey: true },
    { key: 'x', code: 'KeyX', vk: 88, ctrlKey: true },
  ])('$key通过官方stream传递CDP默认行为需要的VK与Enter文本，keyup不重复带文本', async ({ key, code, vk, text, metaKey = false, ctrlKey = false }) => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.keyDown(input, { key, code, metaKey, ctrlKey });
    fireEvent.keyUp(input, { key, code, metaKey, ctrlKey });
    const fields = { key, code, windowsVirtualKeyCode: vk, modifiers: metaKey || ctrlKey ? 2 : 0 };
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', ...fields, ...(text ? { text } : {}) },
      { type: 'input_keyboard', eventType: 'keyUp', ...fields },
    ]);
  });
  it('按UTF8完整拒绝超过16KiB的单次粘贴，保留明确错误且不截断发送', async () => {
    const { socket } = await start(); await paint(socket);
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { getData: () => '你'.repeat(6000) } });
    expect(await screen.findByRole('alert')).toHaveTextContent('16 KiB');
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    expect(insertedTexts()).toEqual([]);
    expect(socket.closed).toBe(false);
  });
  it('输入流本地积压达到512KiB时关闭并提示，重连不重放被拒绝的按键输入', async () => {
    const { socket } = await start(); await paint(socket);
    socket.bufferedAmount = 512 * 1024;
    fireEvent(screen.getByLabelText('网页键盘输入'), new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'x', inputType: 'insertText' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('积压');
    expect(socket.closed).toBe(true);
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    expect(BrowserSocket.instances).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '重新连接浏览器画面' }));
    await waitFor(() => expect(BrowserSocket.instances).toHaveLength(2));
    const next = BrowserSocket.instances[1]; await paint(next);
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { getData: () => '新的输入' } });
    await waitFor(() => expect(insertedTexts()).toContain('新的输入'));
    expect(next.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('超限粘贴拒绝后正常新帧不抹掉未发送提示，下次成功文字输入才清除', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.paste(input, { clipboardData: { getData: () => '你'.repeat(6000) } });
    expect(screen.getByRole('alert')).toHaveTextContent('本次内容未发送');
    act(() => socket.frame(2));
    fireEvent.load(screen.getByAltText('独立浏览器当前页面'));
    await waitFor(() => expect(socket.sent).toContainEqual({ type: 'ack', seq: 2 }));
    expect(screen.getByRole('alert')).toHaveTextContent('本次内容未发送');
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    fireEvent.paste(input, { clipboardData: { getData: () => '分段后的文字' } });
    await waitFor(() => expect(insertedTexts()).toEqual(['分段后的文字']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('原生粘贴缺少clipboardData且beforeinput.data为空时，转发实际插入值一次再清空输入器', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入') as HTMLTextAreaElement;
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    fireEvent(input, paste);
    expect(paste.defaultPrevented).toBe(false);
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: null, inputType: 'insertFromPaste' }));
    input.value = '原生粘贴内容';
    fireEvent.input(input, { inputType: 'insertFromPaste', data: null });
    fireEvent.input(input, { inputType: 'insertFromPaste', data: null });
    await waitFor(() => expect(insertedTexts()).toEqual(['原生粘贴内容']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    expect(input).toHaveValue('');
  });
  it('正常paste已接管时，后续insertFromPaste beforeinput不会重复发送正文', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.paste(input, { clipboardData: { getData: () => '正常粘贴' } });
    fireEvent(input, new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: '正常粘贴', inputType: 'insertFromPaste' }));
    await waitFor(() => expect(insertedTexts()).toEqual(['正常粘贴']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('输入诊断仅显式构建开关开启，最多12条且不包含正文', async () => {
    vi.stubEnv('VITE_AKB_BROWSER_INPUT_DIAGNOSTICS', '1');
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入') as HTMLTextAreaElement;
    for (let index = 0; index < 15; index++) {
      input.value = '诊断敏感内容';
      fireEvent.input(input, { inputType: 'insertFromPaste', data: null });
    }
    const output = screen.getByLabelText('浏览器输入诊断');
    await waitFor(() => expect(JSON.parse(screen.getByLabelText('浏览器输入诊断').textContent!).at(-1).inputType).toBe('insert_text'));
    const events = JSON.parse(output.textContent!);
    expect(events).toHaveLength(12);
    expect(events[events.length - 1]).toEqual({ type: 'send', inputType: 'insert_text', dataBytes: 18, valueBytes: 0, sent: true });
    expect(output).not.toHaveTextContent('诊断敏感内容');
  });
  it.each(['v', 'c'])('独立Meta键不转发Control，Cmd+%s仍由本机剪贴板路径处理', async key => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    expect(fireEvent.keyDown(input, { key: 'Meta', code: 'MetaLeft', metaKey: true })).toBe(true);
    fireEvent.keyDown(input, { key, code: key === 'v' ? 'KeyV' : 'KeyC', metaKey: true });
    if (key === 'v') fireEvent.paste(input, { clipboardData: { getData: () => '原生粘贴' } });
    fireEvent.keyUp(input, { key, code: key === 'v' ? 'KeyV' : 'KeyC', metaKey: true });
    fireEvent.keyUp(input, { key: 'Meta', code: 'MetaLeft', metaKey: false });
    if (key === 'v') await waitFor(() => expect(insertedTexts()).toEqual(['原生粘贴']));
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
    if (key === 'c') expect(invoke).toHaveBeenCalledWith('chat_browser', expect.objectContaining({ method: 'copy_selection' }));
  });
  it('Cmd+A通过A键的Ctrl修饰位工作，不发送独立Control按下或释放', async () => {
    const { socket } = await start(); await paint(socket);
    const input = screen.getByLabelText('网页键盘输入');
    fireEvent.keyDown(input, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fireEvent.keyDown(input, { key: 'a', code: 'KeyA', metaKey: true });
    fireEvent.keyUp(input, { key: 'a', code: 'KeyA', metaKey: true });
    fireEvent.keyUp(input, { key: 'Meta', code: 'MetaLeft', metaKey: false });
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 },
    ]);
  });
  it('诊断开关记录粘贴后的页面插入结果，且不包含正文', async () => {
    vi.stubEnv('VITE_AKB_BROWSER_INPUT_DIAGNOSTICS', '1');
    const { socket } = await start(); await paint(socket);
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { getData: () => 'send-report' } });
    await waitFor(() => expect(screen.getByLabelText('浏览器输入诊断')).toHaveTextContent('insert_text'));
    const output = screen.getByLabelText('浏览器输入诊断'), events = JSON.parse(output.textContent!);
    expect(events[events.length - 1]).toEqual({ type: 'send', inputType: 'insert_text', dataBytes: 11, valueBytes: 0, sent: true });
    expect(output).not.toHaveTextContent('send-report');
  });
  it.each(['text', 'image'])('诊断明确区分%s粘贴分支，不凭同时存在文本误报发送成功', async branch => {
    vi.stubEnv('VITE_AKB_BROWSER_INPUT_DIAGNOSTICS', '1');
    const { socket } = await start(); await paint(socket);
    const file = transferFile('image.png', 3, 'image/png').file;
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: {
      getData: () => 'text-13-bytes',
      files: branch === 'image' ? [file] : [],
      items: [{ kind: 'string', type: 'text/plain' }],
    } });
    const events = JSON.parse(screen.getByLabelText('浏览器输入诊断').textContent!);
    expect(events).toContainEqual({ type: 'paste_branch', inputType: branch, dataBytes: 13, valueBytes: 0 });
    expect(events.some((event: { type: string }) => event.type === 'send')).toBe(branch === 'text');
    if (branch === 'image') await waitFor(() => expect(transfers('upload_finish')).toHaveLength(1));
  });
  it.each(['CuaClip165-long', '一段完整中文粘贴', '😀a👩‍💻\n第二行'])('整段粘贴%s通过页面插入一次完成，内容原样提交', async text => {
    const { socket } = await start(); await paint(socket);
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(insertedTexts()).toEqual([text]));
    expect(transfers('insert_text')[0].params).toEqual({ target_id: 'one', text });
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('页面插入失败时展示明确错误，不宣称已发送', async () => {
    const { socket } = await start(); await paint(socket);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (name, args, options) => (args as { method: string }).method === 'insert_text'
      ? Promise.reject(new Error('请先点击网页中的输入位置')) : original(name, args, options));
    fireEvent.paste(screen.getByLabelText('网页键盘输入'), { clipboardData: { getData: () => 'abc' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('请先点击网页中的输入位置');
    expect(socket.sent.filter(value => value.type === 'input_keyboard')).toEqual([]);
  });
  it('启动失败展示错误且不切换其他浏览器或修改会话配置', async () => {
    const state = fixture(); vi.mocked(invoke).mockRejectedValue(new Error('Docker 不可用'));
    render(view({ ...state, conversation: { ...conversation, thread_id: 'old-thread' } }));
    await userEvent.click(screen.getByRole('button', { name: '打开侧边浏览器' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Docker 不可用');
    expect(state.command).not.toHaveBeenCalled(); expect(state.newConversation).not.toHaveBeenCalled();
    expect(BrowserSocket.instances).toHaveLength(0);
  });
});
