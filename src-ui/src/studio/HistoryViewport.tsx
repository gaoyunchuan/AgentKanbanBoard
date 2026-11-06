import {Component, type ReactNode, type RefObject} from 'react';
import type {HistoryPage} from './useConversationHistory';

type Props = {
  scroll: RefObject<HTMLDivElement>;
  content: RefObject<HTMLDivElement>;
  page?: HistoryPage;
  liveLast?: number;
  onPosition: (top: number) => void;
  children: ReactNode;
};
type Snapshot = {
  anchors: {id: string; offset: number}[];
  top: number;
  height: number;
  prepend: boolean;
  follow: boolean;
};

export class HistoryViewport extends Component<Props, object, Snapshot | null> {
  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const {scroll,content,page,liveLast} = this.props;
    const view = scroll.current;
    if (!view || !content.current || previous.page === page) return null;
    const bounds = view.getBoundingClientRect();
    const anchors = [];
    for (const node of content.current.querySelectorAll<HTMLElement>('[data-history-anchor]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > bounds.top + 1 && rect.top < bounds.bottom) {
        anchors.push({id:node.dataset.historyAnchor!,offset:rect.top-bounds.top});
      }
    }
    // 同一回合补齐前半段时，气泡比整轮容器更适合作为阅读锚点。
    anchors.sort((a,b)=>Number(a.id.startsWith('turn:'))-Number(b.id.startsWith('turn:')));
    const oldLast = previous.page?.events[previous.page.events.length-1]?.id;
    const newLast = page?.events[page.events.length-1]?.id;
    const oldFirst = previous.page?.events[0]?.id;
    const newFirst = page?.events[0]?.id;
    const atBottom = view.scrollHeight-view.scrollTop-view.clientHeight < 90;
    return {anchors,top:view.scrollTop,height:view.scrollHeight,
      prepend:oldFirst!==undefined && newFirst!==undefined && newFirst<oldFirst && newLast===oldLast,
      follow: !previous.page || Boolean(atBottom && oldLast===previous.liveLast && liveLast!==previous.liveLast && newLast===liveLast)};
  }

  componentDidUpdate(_previous: Props, _state: object, snapshot: Snapshot | null) {
    const view = this.props.scroll.current;
    if (!snapshot || !view) return;
    if (snapshot.follow) {
      view.scrollTop = view.scrollHeight;
    } else {
      const current = new Map(Array.from(this.props.content.current?.querySelectorAll<HTMLElement>('[data-history-anchor]') ?? [])
        .map(node=>[node.dataset.historyAnchor,node]));
      const saved = snapshot.anchors.find(entry=>current.has(entry.id));
      if (saved) {
        const element = current.get(saved.id)!;
        view.scrollTop += element.getBoundingClientRect().top-view.getBoundingClientRect().top-saved.offset;
      } else {
        view.scrollTop = snapshot.top + (snapshot.prepend ? view.scrollHeight-snapshot.height : 0);
      }
    }
    this.props.onPosition(view.scrollTop);
  }

  render() {
    const {content,page,children} = this.props;
    return <div ref={content} className="continuous-history" data-first-event={page?.events[0]?.id}
      data-last-event={page?.events[page.events.length-1]?.id}>{children}</div>;
  }
}
