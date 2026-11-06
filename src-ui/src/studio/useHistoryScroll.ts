import {useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject} from 'react';
import type {StudioApi} from './api';
import type {HistoryPage} from './useConversationHistory';
import {extendHistoryWindow, historyPrefetchDirection, type HistoryDirection, type HistoryWindow} from './historyWindow';

export function useHistoryScroll(api: StudioApi, id: string, live: HistoryPage | undefined, scroll: RefObject<HTMLDivElement>) {
  const [window, setWindow] = useState<HistoryWindow>();
  const [error, setError] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const lastTop = useRef(0);
  const intention = useRef<HistoryDirection>();
  const initialPages = useRef(3);
  const request = useRef<symbol>();
  const retryAt = useRef(0);
  const schedule = useRef<() => void>();
  const liveLast = live?.events[live.events.length-1]?.id;
  const displayed = useMemo(() => {
    if (!window) return live && {...live,newer:false};
    if (!live || window.newer) return window;
    const last = window.events[window.events.length-1]?.id;
    const liveFirst = live.events[0]?.id;
    if (last===undefined || liveFirst===undefined || liveLast===undefined || liveFirst>last || liveLast<=last) return window;
    // 同一次提交合并实时消息，保留上一帧的底部状态供视口判断。
    return extendHistoryWindow(window,{...live,events:live.events.filter(event=>event.id>last)},'newer');
  }, [window,live,liveLast]);
  const first = displayed?.events[0]?.id;
  const last = displayed?.events[displayed.events.length-1]?.id;
  const newer = Boolean(displayed?.newer || (window && last && liveLast && last < liveLast));
  const committed = useRef({displayed, first, last, newer});
  useLayoutEffect(() => {
    committed.current = {displayed, first, last, newer};
    if (window && displayed && window!==displayed) setWindow(displayed);
    schedule.current?.();
  }, [window, displayed, first, last, newer]);

  useEffect(() => {
    const view = scroll.current;
    const node = content.current;
    if (!view || !node) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let queued = false;

    const fetch = async (direction: HistoryDirection, edge: number) => {
      if (request.current) return;
      const token = Symbol();
      request.current = token;
      let applied = false;
      try {
        const cursor = direction==='older' ? {before:edge} : {after:edge};
        const page = await api.call<HistoryPage>('history_page', {conversation_id:id, transcript:true, ...cursor});
        const current = committed.current;
        if (disposed || request.current !== token || !current.displayed) return;
        const stillAtEdge = direction==='older' ? current.first===edge : current.last===edge;
        // 用户反向滚动后，不把上一方向的迟到结果接进窗口，避免淘汰正在看的另一端。
        if (!stillAtEdge || intention.current!==undefined && intention.current!==direction) return;
        setWindow(extendHistoryWindow(current.displayed,page,direction));
        setError(false);
        retryAt.current = 0;
        applied = true;
      } catch {
        if (disposed || request.current!==token) return;
        setError(true);
        retryAt.current = Date.now() + 2000;
        retry = setTimeout(queue,2000);
      } finally {
        if (request.current === token) request.current = undefined;
        if (!disposed && !applied) queue();
      }
    };

    function check() {
      queued = false;
      if (!view || view.clientHeight===0 || Date.now()<retryAt.current) return;
      const {first,last,displayed,newer} = committed.current;
      if (first===undefined || last===undefined || !displayed) return;
      const direction = historyPrefetchDirection(view,{older:displayed.older,newer},intention.current,initialPages.current>0);
      if (!direction || request.current) return;
      if (!intention.current) initialPages.current--;
      void fetch(direction,direction==='older' ? first : last);
    }
    function queue() {
      if (queued) return;
      queued = true;
      frame = requestAnimationFrame(check);
    }
    function onScroll() {
      const top = view!.scrollTop;
      if (Math.abs(top-lastTop.current)>2) {
        intention.current = top < lastTop.current ? 'older' : 'newer';
        initialPages.current = 0;
      }
      lastTop.current = top;
      queue();
    }
    function onWheel(event: WheelEvent) {
      if (event.deltaY !== 0) {
        intention.current = event.deltaY < 0 ? 'older' : 'newer';
        initialPages.current = 0;
      }
      queue();
    }
    schedule.current = queue;
    lastTop.current = view.scrollTop;
    view.addEventListener('scroll',onScroll,{passive:true});
    view.addEventListener('wheel',onWheel,{passive:true});
    const observer = typeof ResizeObserver==='undefined' ? undefined : new ResizeObserver(queue);
    observer?.observe(node);
    observer?.observe(view);
    queue();
    return () => {
      disposed = true;
      request.current = undefined;
      schedule.current = undefined;
      clearTimeout(retry);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      view.removeEventListener('scroll',onScroll);
      view.removeEventListener('wheel',onWheel);
    };
  }, [api,id,scroll]);

  function jump(page: HistoryPage) {
    request.current = undefined;
    intention.current = 'older';
    setWindow({...page, newer:Boolean(liveLast && (page.events[page.events.length-1]?.id ?? 0)<liveLast)});
    requestAnimationFrame(() => {
      const view = scroll.current;
      if (view) {
        view.scrollTop = view.scrollHeight;
        lastTop.current = view.scrollTop;
      }
    });
  }

  function returnToLive() {
    request.current = undefined;
    intention.current = 'newer';
    initialPages.current = 0;
    setWindow(undefined);
    requestAnimationFrame(() => {
      const view = scroll.current;
      if (view) {
        view.scrollTop = view.scrollHeight;
        lastTop.current = view.scrollTop;
      }
    });
  }

  return {content, displayed, error, newer, jump, returnToLive, liveLast, onPosition:(top:number)=>{lastTop.current=top;}};
}
