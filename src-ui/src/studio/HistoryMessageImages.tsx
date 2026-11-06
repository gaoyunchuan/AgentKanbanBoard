import {createContext, useContext, useEffect, useRef, useState} from 'react';
import {inlineImageUrl} from '../lib/imageUrl';
import type {HistoryImageRef} from '../workbench/events';

export const HistoryImageLoader = createContext<((image: HistoryImageRef) => Promise<string>) | null>(null);
const MAX_IMAGE_READS = 2;
let pendingReads = 0;

export function HistoryMessageImage({image,index,generated=false}: {image:HistoryImageRef;index:number;generated?:boolean}) {
  const load = useContext(HistoryImageLoader);
  const frame = useRef<HTMLDivElement>(null);
  const [near,setNear] = useState(false);
  const [result,setResult] = useState<{src?:string;error?:boolean}>();

  useEffect(() => {
    const node = frame.current;
    if (!node || !load) return;
    if (typeof IntersectionObserver==='undefined') { setNear(true); return; }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting),{
      root:node.closest('.chat-scroll'),rootMargin:'360px 0px',
    });
    observer.observe(node);
    return () => observer.disconnect();
  },[load]);

  useEffect(() => {
    if (!near || !load) { setResult(undefined); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      if (!load || disposed) return;
      if (pendingReads>=MAX_IMAGE_READS) {
        timer = setTimeout(read,100);
        return;
      }
      pendingReads++;
      try {
        const src = inlineImageUrl(await load(image));
        if (!disposed) setResult(src ? {src} : {error:true});
      } catch {
        if (!disposed) setResult({error:true});
      } finally {
        pendingReads--;
      }
    }
    void read();
    return () => { disposed = true; clearTimeout(timer); };
  },[near,load,image.eventId,image.slot]);

  return <div ref={frame} className="history-image-frame">
    {result?.src && !result.error
      ? <img className="message-image" src={result.src} alt={`${generated ? '生成的图片' : '已发送的图片'} ${index+1}`} decoding="async" onError={()=>setResult({error:true})}/>
      : <span className="message-image-error">{result?.error || !load ? '图片加载失败' : '图片加载中…'}</span>}
  </div>;
}
