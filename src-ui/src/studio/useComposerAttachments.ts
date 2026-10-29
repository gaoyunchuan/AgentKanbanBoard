import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Draft } from './context';

const MAX_ATTACHMENTS = 16;
const MAX_FILE_BYTES = 4_000_000;
const IMAGE_TYPE = /^image\/(png|jpeg|webp|gif)$/;
const TEXT_FILE = /\.(md|txt|json|ya?ml|toml|rs|go|tsx?|jsx?|py|sh|sql|log|css|html)$/i;

function validateFiles(files: File[], existing: number) {
  if (files.length + existing > MAX_ATTACHMENTS) throw new Error('每条消息最多 16 个附件');
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} 超过 4 MB，请按范围引用文件`);
    if (file.type.startsWith('image/')) {
      if (!IMAGE_TYPE.test(file.type)) throw new Error('图片支持 PNG、JPEG、WebP 和 GIF');
    } else if (!TEXT_FILE.test(file.name)) {
      throw new Error('此文件暂不直接解析，请选用文本/Markdown或图片，或在消息中引用项目内路径');
    }
  }
}

function readFile(file: File, signal: AbortSignal): Promise<Draft['attachments'][number]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException('附件读取已取消', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    reader.onloadend = () => signal.removeEventListener('abort', abort);
    reader.onerror = () => reject(reader.error || new Error(`无法读取 ${file.name}`));
    reader.onload = () => {
      const content = String(reader.result);
      resolve(file.type.startsWith('image/')
        ? { name: file.name || '粘贴图片', input: { type: 'image', url: content } }
        : { name: file.name, text: content });
    };
    if (file.type.startsWith('image/')) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

export function attachmentImage(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as { type?: string; url?: string };
  if (value.type === 'image' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(value.url || '')) return value.url;
}

export function clipboardImages(data: DataTransfer): File[] {
  // items 和 files 通常描述同一张图片，不能把两者拼接导致重复附件。
  const items = Array.from(data.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  const images = items.map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
  return images.length ? images : Array.from(data.files || []).filter(file => file.type.startsWith('image/'));
}

export function useComposerAttachments(owner: string, draft: Draft,
  setDraft: Dispatch<SetStateAction<Draft>>, notify: (message: string) => void) {
  const [reading, setReading] = useState(false);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setReading(false);
    return () => { active.current?.abort(); active.current = null; };
  }, [owner]);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    if (active.current) { notify('正在读取附件，请稍后再添加'); return; }
    const controller = new AbortController();
    active.current = controller;
    setReading(true);
    try {
      // 先检查整批数量、大小和类型，避免无效批次占用读取内存。
      validateFiles(files, draft.attachments.length);
      const additions: Draft['attachments'] = [];
      for (const file of files) additions.push(await readFile(file, controller.signal));
      if (controller.signal.aborted || currentOwner.current !== owner) return;
      // 读取期间仍允许输入，必须合并最新草稿，不能恢复读取前的旧文本。
      setDraft(current => ({ ...current, attachments: [...current.attachments, ...additions] }));
    } catch (error) {
      if (!controller.signal.aborted && currentOwner.current === owner) notify(String(error));
    } finally {
      if (active.current === controller) { active.current = null; setReading(false); }
    }
  };
  return { reading, upload };
}
