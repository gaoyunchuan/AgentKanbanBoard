import {useEffect, useState} from 'react';
import type {StudioApi} from './api';
import type {WorkEvent, WorkRun} from '../workbench/types';

export type HistoryEvent = WorkEvent & {truncated?: boolean};
export type HistoryPage = {events: HistoryEvent[]; runs: WorkRun[]; older: boolean; more: boolean};

function mergeTail(current: HistoryPage, delta: HistoryPage): HistoryPage {
  const events = [...current.events, ...delta.events];
  let first = Math.max(0, events.length - 96);
  let size = 0;
  for (let i = events.length - 1; i >= first; i--) {
    size += JSON.stringify(events[i]).length;
    if (size > 768 * 1024) {
      first = i + 1;
      break;
    }
  }
  const kept = events.slice(first);
  const runIds = new Set(kept.map(event => event.run_id));
  const runs = new Map([...current.runs, ...delta.runs].map(run => [run.id, run]));
  return {events: kept, runs: [...runs.values()].filter(run => runIds.has(run.id)), older: current.older || first > 0, more: delta.more};
}

export function useConversationHistory(api: StudioApi, conversationId?: string) {
  const [result, setResult] = useState<{id: string; page?: HistoryPage; error?: string}>();
  useEffect(() => {
    if (!conversationId) return;
    let disposed = false;
    let page: HistoryPage | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const after = page && page.events[page.events.length - 1]?.id;
        const delta = await api.call<HistoryPage>('history_page', {conversation_id: conversationId, after, transcript:true});
        if (disposed) return;
        if (delta.events.length || !page) page = page ? mergeTail(page, delta) : delta;
        setResult(previous => previous && previous.id === conversationId && previous.page === page && !previous.error
          ? previous : {id: conversationId!, page});
      } catch (error) {
        if (!disposed) setResult({id: conversationId!, page, error: String(error)});
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1200);
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, conversationId]);
  return result?.id === conversationId ? result : undefined;
}
