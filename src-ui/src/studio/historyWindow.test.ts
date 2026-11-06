import {expect, it} from 'vitest';
import {extendHistoryWindow, historyPrefetchDirection} from './historyWindow';
import type {HistoryPage} from './useConversationHistory';

const page = (first: number, last: number, older = true): HistoryPage => ({
  older, more: false, runs: [],
  events: Array.from({length:last-first+1}, (_,i) => ({
    id:first+i, task_id:'task', kind:'user_message', created_at:'', payload:{text:'消息'},
  })),
});

it('向上接入旧消息时保留顺序和重叠边界，只淘汰远端', () => {
  const current = {...page(4,6), newer:false};
  const result = extendHistoryWindow(current,page(1,4,false),'older',{rows:5,bytes:10000});
  expect(result.events.map(e=>e.id)).toEqual([1,2,3,4,5]);
  expect(result.older).toBe(false);
  expect(result.newer).toBe(true);
});

it('向下读回被淘汰的消息后可接续最新窗口', () => {
  const current = {...page(1,5,false), newer:true};
  const result = extendHistoryWindow(current,page(5,7),'newer',{rows:5,bytes:10000});
  expect(result.events.map(e=>e.id)).toEqual([3,4,5,6,7]);
  expect(result.older).toBe(true);
  expect(result.newer).toBe(false);
});

it('向下读到最新且内容恰好铺满窗口时，不反向预取', () => {
  const viewport = {scrollTop:0,scrollHeight:800,clientHeight:800};
  expect(historyPrefetchDirection(viewport,{older:true,newer:false},'newer',true)).toBeUndefined();
  expect(historyPrefetchDirection(viewport,{older:true,newer:false},undefined,false)).toBeUndefined();
  expect(historyPrefetchDirection(viewport,{older:true,newer:false},'older',false)).toBe('older');
});
