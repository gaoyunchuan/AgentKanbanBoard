import {act,renderHook,waitFor} from '@testing-library/react';
import {afterEach,expect,test,vi} from 'vitest';
import {useConversationRead} from './useConversationRead';
import type {Conversation} from './model';
afterEach(()=>vi.restoreAllMocks());
const conversation={id:'c',read_version:0,last_output_event_id:12,unread:true,manual_unread:false} as Conversation;

test('前台底部只确认已加载边界，滚动旧内容与后台不确认',async()=>{
 vi.spyOn(document,'hasFocus').mockReturnValue(true);
 const ack=vi.fn().mockResolvedValue(undefined);
 const {rerender}=renderHook(({bottom})=>useConversationRead(conversation,1,bottom,ack),{initialProps:{bottom:false}});
 expect(ack).not.toHaveBeenCalled();rerender({bottom:true});
 await waitFor(()=>expect(ack).toHaveBeenCalledWith(12,0));
 act(()=>window.dispatchEvent(new Event('focus')));expect(ack).toHaveBeenCalledTimes(1);
});

test('失焦保持未读，回到窗口才确认；当前人工未读必须重新打开',async()=>{
 let focus=false;vi.spyOn(document,'hasFocus').mockImplementation(()=>focus);
 const ack=vi.fn().mockResolvedValue(undefined);
 const {rerender}=renderHook(({c,session})=>useConversationRead(c,session,true,ack),{initialProps:{c:conversation,session:1}});
 expect(ack).not.toHaveBeenCalled();focus=true;act(()=>window.dispatchEvent(new Event('focus')));
 await waitFor(()=>expect(ack).toHaveBeenCalledTimes(1));
 const marked={...conversation,manual_unread:true,read_version:1};rerender({c:marked,session:1});
 expect(ack).toHaveBeenCalledTimes(1);rerender({c:marked,session:2});
 await waitFor(()=>expect(ack).toHaveBeenLastCalledWith(12,1));
});

test('已手工标未读后立即重开，迟到的新详情仍能一次清除',async()=>{
 vi.spyOn(document,'hasFocus').mockReturnValue(true);
 const ack=vi.fn().mockResolvedValue(undefined);
 const {rerender}=renderHook(({c,session,currentVersion})=>useConversationRead(c,session,true,ack,currentVersion),{initialProps:{c:{...conversation,unread:false},session:1,currentVersion:0}});
 // 快照已显示人工蓝点，详情还是旧值；用户此时重开。
 rerender({c:{...conversation,unread:false},session:2,currentVersion:1});
 rerender({c:{...conversation,unread:true,manual_unread:true,read_version:1},session:2,currentVersion:1});
 await waitFor(()=>expect(ack).toHaveBeenCalledWith(12,1));
});
