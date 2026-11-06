import {useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {ChatTranscript} from './ChatTranscript';
import type {StudioApi} from './api';
import type {HistoryPage} from './useConversationHistory';
import {useHistoryScroll} from './useHistoryScroll';
import {HistoryImageLoader} from './HistoryMessageImages';
import type {HistoryImageRef} from '../workbench/events';
import {HistoryViewport} from './HistoryViewport';

type SearchResult = {matches: {id: number; kind: string; created_at: string}[]; next: number | null};
type Chunk = {text: string; next: number | null};

export function ConversationHistory({api, id, live, error, scroll, currentRunId, onGap, revealLatest}: {
  api: StudioApi; id: string; live?: HistoryPage; error?: string; scroll: RefObject<HTMLDivElement>;
  currentRunId?: string | null; onGap: (newer: boolean) => void; revealLatest: number;
}) {
  const history = useHistoryScroll(api,id,live,scroll);
  const loadImage = useCallback(({eventId,slot}:HistoryImageRef) =>
    api.call<string>('history_image',{conversation_id:id,event_id:eventId,slot}),[api,id]);
  useEffect(() => onGap(history.newer), [history.newer,onGap]);
  const lastReveal = useRef(revealLatest);
  useLayoutEffect(() => {
    if (lastReveal.current === revealLatest) return;
    lastReveal.current = revealLatest;
    history.returnToLive();
  }, [revealLatest,history]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchResult>();
  const [activeQuery, setActiveQuery] = useState('');
  const [selected, setSelected] = useState<number>();
  const [offset, setOffset] = useState(0);
  const [chunk, setChunk] = useState<Chunk>();
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const displayed = history.displayed;

  async function request<T>(method: string, params: Record<string, unknown>, apply: (value: T) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setActionError('');
    try {
      const value = await api.call<T>(method, {conversation_id: id, ...params});
      if (mounted.current) apply(value);
    } catch (error) {
      if (mounted.current) setActionError(String(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  function browse(before: number) {
    void request<HistoryPage>('history_page', {before, transcript:true}, page => {
      setSelected(undefined);
      history.jump(page);
    });
  }

  function find(text: string, before?: number) {
    void request<SearchResult>('history_search', {query: text, before}, value => {
      setActiveQuery(text);
      setSearch(value);
    });
  }

  function openRecord(eventId: number, start = 0) {
    void request<Chunk>('history_chunk', {event_id: eventId, offset: start}, value => {
      setSelected(eventId);
      setOffset(start);
      setChunk(value);
    });
  }

  return <>
    <div className="conversation-history-controls">
      <form onSubmit={event => { event.preventDefault(); find(query); }}>
        <input type="search" aria-label="搜索会话历史" placeholder="搜索会话历史" value={query} onChange={event => setQuery(event.target.value)}/>
        <button className="textbtn" disabled={loading || !query.trim()}>搜索</button>
      </form>
    </div>
    {search && <div className="conversation-history-controls" aria-label="历史搜索结果">
      <span>{search.matches.length ? `本批匹配 ${search.matches.length} 条` : '本批未找到匹配'}</span>
      <button className="textbtn" onClick={() => setSearch(undefined)} disabled={loading}>关闭搜索结果</button>
      {search.next !== null && <button className="textbtn" disabled={loading} onClick={() => find(activeQuery, search.next!)}>继续向前搜索</button>}
      <ul>{search.matches.map(match => <li key={match.id}>
        <button className="textbtn" disabled={loading} onClick={() => browse(match.id + 1)}>{match.created_at} · 记录 {match.id}</button>
        <button className="textbtn" disabled={loading} onClick={() => openRecord(match.id)}>查看原文</button>
      </li>)}</ul>
    </div>}
    {(actionError || error) && <div role="status" className="warning-box">{actionError || '历史暂时无法刷新，正在重试。'}</div>}
    {selected !== undefined && chunk && <section className="history-record" aria-label="历史原文">
      <div className="conversation-history-controls">
        <span>记录 {selected} · 第 {offset + 1} 字符起</span>
        <button className="textbtn" disabled={loading || offset === 0} onClick={() => openRecord(selected, Math.max(0, offset - 32768))}>上一段</button>
        <button className="textbtn" disabled={loading || chunk.next === null} onClick={() => openRecord(selected, chunk.next!)}>下一段</button>
        <button className="textbtn" disabled={loading} onClick={() => setSelected(undefined)}>收起原文</button>
      </div>
      <pre>{chunk.text}</pre>
    </section>}
    <HistoryViewport content={history.content} scroll={scroll} page={displayed} liveLast={history.liveLast} onPosition={history.onPosition}>
      {history.error && <div role="status" className="history-load-status">历史暂时无法加载，正在重试。</div>}
      <HistoryImageLoader.Provider value={loadImage}><ChatTranscript events={displayed?.events ?? []} runs={displayed?.runs ?? []}
        currentRunId={currentRunId} onOpenRecord={eventId => openRecord(eventId)}/></HistoryImageLoader.Provider>
    </HistoryViewport>
  </>;
}
