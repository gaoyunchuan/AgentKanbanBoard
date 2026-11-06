import type {HistoryEvent, HistoryPage} from './useConversationHistory';

export type HistoryWindow = HistoryPage & {newer: boolean};
export type HistoryDirection = 'older' | 'newer';

const windowLimit = {rows: 768, bytes: 6 * 1024 * 1024};

// 同一页在多个滚动窗口间复用，避免每次翻页都重新序列化整段历史。
const eventWeights = new WeakMap<HistoryEvent, number>();
function weight(event: HistoryEvent) {
  const previous = eventWeights.get(event);
  if (previous !== undefined) return previous;
  const bytes = JSON.stringify(event).length * 2;
  eventWeights.set(event, bytes);
  return bytes;
}

export function extendHistoryWindow(current: HistoryWindow, page: HistoryPage, direction: HistoryDirection, limit = windowLimit): HistoryWindow {
  const byId = new Map([...current.events, ...page.events].map(event => [event.id, event]));
  const ordered = [...byId.values()].sort((a,b) => a.id-b.id);
  // 从刚浏览的一端保留记录。被淘汰的另一端可以沿原事件 ID 再读回来。
  const candidates = direction === 'older' ? ordered : [...ordered].reverse();
  let bytes = 0;
  let count = 0;
  for (const event of candidates) {
    bytes += weight(event);
    if (count >= limit.rows || bytes > limit.bytes) break;
    count++;
  }
  const evicted = count < ordered.length;
  const events = direction === 'older' ? ordered.slice(0,count) : ordered.slice(ordered.length-count);
  const ids = new Set(events.map(event=>event.run_id));
  const runs = new Map([...current.runs, ...page.runs].map(run=>[run.id,run]));
  return {
    events,
    runs: [...runs.values()].filter(run=>ids.has(run.id)),
    older: direction === 'older' ? page.older : current.older || evicted,
    newer: direction === 'newer' ? page.more : current.newer || evicted,
    more: false,
  };
}

export function historyPrefetchDirection(
  {scrollTop, scrollHeight, clientHeight}: {scrollTop:number;scrollHeight:number;clientHeight:number},
  {older,newer}: {older:boolean;newer:boolean},
  intention: HistoryDirection | undefined,
  initialFill: boolean,
): HistoryDirection | undefined {
  if (!clientHeight) return;
  const distance = Math.max(320,clientHeight*0.85);
  if (intention==='newer') {
    return newer && scrollHeight-scrollTop-clientHeight<distance ? 'newer' : undefined;
  }
  if (!older || scrollTop>=distance) return;
  if (intention==='older' || initialFill && !newer && scrollHeight<=clientHeight+1) return 'older';
}
