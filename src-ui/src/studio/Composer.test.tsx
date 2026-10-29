import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatApp from './ChatApp';
import { createDemoApi } from './demo';
import type { Workspace } from './model';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.reject('preview must not invoke Tauri')) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const image = () => new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], '粘贴图片.png', { type: 'image/png' });
function pasteImage(input: HTMLElement, file = image()) {
  return fireEvent.paste(input, { clipboardData: {
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }], files: [file], getData: () => '',
  } });
}
async function composer() {
  const api = createDemoApi(), user = userEvent.setup();
  const data = await api.call<Workspace>('snapshot');
  const conversation = data.conversations.find(c => c.mode === 'manual')!;
  const calls = vi.spyOn(api, 'call');
  render(<ChatApp api={api}/>);
  await user.click(await screen.findByRole('button', { name: conversation.title }));
  const input = screen.getByRole('textbox', { name: '聊天输入' });
  const sends = () => calls.mock.calls.filter(([method]) => method === 'send');
  return { api, user, input, sends, conversation };
}

describe('主会话输入', () => {
  it('输入法确认 Enter 不发送，结束组合后的下一次 Enter 只发送一次完整文本', async () => {
    const { input, sends } = await composer();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '需要继续输入' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });
    expect(sends()).toHaveLength(0);
    fireEvent.compositionEnd(input);
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '需要继续输入完整消息' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1]).toMatchObject({ text: '需要继续输入完整消息' });
  });
  it('兼容 WebKit 在 compositionend 后仍发出 keyCode 229 的确认键', async () => {
    const { input, sends } = await composer();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '尚未发完' } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
    expect(sends()).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sends()).toHaveLength(1));
  });
  it('保留 Shift+Enter 换行和普通文本粘贴', async () => {
    const { input, user, sends } = await composer();
    await user.type(input, '第一行');
    await user.keyboard('{Shift>}{Enter}{/Shift}第二行');
    expect(input).toHaveValue('第一行\n第二行');
    expect(sends()).toHaveLength(0);
    expect(fireEvent.paste(input, { clipboardData: { items: [], files: [], getData: () => '文本' } })).toBe(true);
  });
  it('粘贴图片显示预览，items 和 files 同时包含它也只发送一份，并支持纯图片消息', async () => {
    const { input, user, sends, conversation } = await composer();
    expect(pasteImage(input)).toBe(false);
    const preview = await screen.findByRole('img', { name: '粘贴图片.png' });
    expect(preview).toHaveAttribute('src', `data:image/png;base64,${png}`);
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1]).toMatchObject({ conversation_id: conversation.id, text: '', attachments: [{ type: 'image', url: `data:image/png;base64,${png}` }] });
  });
  it('粘贴后可移除图片，移除后空消息不能发送', async () => {
    const { input, user, sends } = await composer();
    pasteImage(input); await screen.findByRole('img', { name: '粘贴图片.png' });
    await user.click(screen.getByRole('button', { name: '移除 粘贴图片.png' }));
    expect(screen.queryByRole('img', { name: '粘贴图片.png' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(sends()).toHaveLength(0);
  });
  it('读取图片时禁止发送，但保留期间继续输入的文字', async () => {
    const original = FileReader.prototype.readAsDataURL;
    let release!: () => void;
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob) {
      release = () => original.call(this, blob);
    });
    const { input, user, sends } = await composer();
    await user.type(input, '原有文本');
    pasteImage(input);
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    await user.type(input, '继续输入');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sends()).toHaveLength(0);
    release(); await screen.findByRole('img', { name: '粘贴图片.png' });
    expect(input).toHaveValue('原有文本继续输入');
    await user.click(screen.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(sends()[0][1]).toMatchObject({ text: '原有文本继续输入', attachments: [{ type: 'image' }] });
  });
  it('读取未完成就切换会话，迟到图片不会进入新旧会话', async () => {
    const original = FileReader.prototype.readAsDataURL;
    let release!: () => void;
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob) {
      release = () => original.call(this, blob);
    });
    const { input, user, conversation } = await composer();
    await user.type(input, '保留这份草稿'); pasteImage(input);
    await user.click(screen.getByRole('button', { name: '新聊天' }));
    release();
    await waitFor(() => expect(screen.queryByText('正在读取附件…')).not.toBeInTheDocument());
    expect(screen.queryByRole('img', { name: '粘贴图片.png' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: conversation.title }));
    expect(screen.getByRole('textbox', { name: '聊天输入' })).toHaveValue('保留这份草稿');
    expect(screen.queryByRole('img', { name: '粘贴图片.png' })).not.toBeInTheDocument();
  });
  it('支持只有 files 的图片剪贴板', async () => {
    const { input } = await composer();
    fireEvent.paste(input, { clipboardData: { files: [image()], items: [], getData: () => '' } });
    expect(await screen.findByRole('img', { name: '粘贴图片.png' })).toBeInTheDocument();
  });
  it.each([
    ['超大图片', () => [new File([new Uint8Array(4_000_001)], 'large.png', { type: 'image/png' })], '超过 4 MB'],
    ['过多图片', () => Array.from({ length: 17 }, image), '最多 16 个附件'],
    ['不支持的图片', () => [new File(['svg'], 'unsafe.svg', { type: 'image/svg+xml' })], '图片支持 PNG'],
  ] as const)('%s 在读取前拒绝，并保留草稿', async (_name, files, message) => {
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    const { input, user } = await composer();
    await user.type(input, '保留文字');
    fireEvent.paste(input, { clipboardData: { items: [], files: files(), getData: () => '' } });
    expect(await screen.findByRole('status')).toHaveTextContent(message);
    expect(read).not.toHaveBeenCalled();
    expect(input).toHaveValue('保留文字');
    expect(screen.queryByRole('img', { name: '粘贴图片.png' })).not.toBeInTheDocument();
  });

});
