import { expect, test } from "vitest";
import { executionDiff, executionTimeline } from "./events";
import type { WorkEvent } from "./types";
const event = (id: number, kind: string, payload: unknown, run_id = "run-a"): WorkEvent => ({ id, kind, payload, run_id, task_id: "task-a", created_at: "now" });

test("streamed answer is replaced by its final item without duplication", () => {
  const events = [event(1, "item/agentMessage/delta", { itemId: "item-a", delta: "完成" }), event(2, "item/agentMessage/delta", { itemId: "item-a", delta: "检查" }), event(3, "item/completed", { item: { id: "item-a", type: "agentMessage", text: "完成检查。" } })];
  expect(executionTimeline(events)).toMatchObject([{ id: "run-a:item-a", role: "agent", text: "完成检查。" }]);
});

test("events from different runs cannot overwrite one another with a reused item ID", () => {
  const result = executionTimeline([event(1, "item/agentMessage/delta", { itemId: "same", delta: "old" }), event(2, "item/agentMessage/delta", { itemId: "same", delta: "new" }, "run-b")]);
  expect(result.map((item) => item.text)).toEqual(["old", "new"]);
});

test("latest aggregated diff is shown rather than concatenating repeated snapshots", () => {
  expect(executionDiff([event(1, "turn/diff/updated", { diff: "old" }), event(2, "runtime", { method: "turn/diff/updated", params: { diff: "new" } })])).toBe("new");
});

test("MCP screenshots render as images without dumping their base64 into tool output", () => {
  const result = executionTimeline([event(1, "item/completed", { item: { id: "browser", type: "mcpToolCall", tool: "browser_take_screenshot", result: { content: [{ type: "image", mimeType: "image/png", data: "AA==" }, { type: "text", text: "页面截图" }] } } })]);
  expect(result[0].images).toEqual(["data:image/png;base64,AA=="]);
  expect(result[0].text).not.toContain("AA==");
  expect(result[0].text).toContain("页面截图");
});

test('preserves commentary/final phase and structured command category',()=>{
 const result=executionTimeline([event(1,'item/completed',{turnId:'turn-a',item:{id:'m',type:'agentMessage',phase:'final_answer',text:'结果'}}),event(2,'item/completed',{turnId:'turn-a',item:{id:'cmd',type:'commandExecution',command:'cat a.md',commandActions:[{type:'read',name:'a.md'}],status:'completed'}})]);
 expect(result[0]).toMatchObject({turnId:'turn-a',phase:'final_answer'});
 expect(result[1]).toMatchObject({toolKind:'read',label:'读取 a.md'});
});

const sentImage = 'data:image/png;base64,AA==';
const secondImage = 'data:image/jpeg;base64,AQ==';
test('本地历史保留纯图消息及多图顺序，图片不进入正文',()=>{
 const result=executionTimeline([
  event(1,'user_message',{text:'看这两张图',attachments:[{type:'image',url:sentImage},{type:'image',url:secondImage}]}),
  event(2,'user_message',{text:'',attachments:[{type:'image',url:sentImage}]}),
 ]);
 expect(result).toHaveLength(2);expect(result[0]).toMatchObject({text:'看这两张图',images:[sentImage,secondImage]});
 expect(result[1]).toMatchObject({role:'user',text:'',images:[sentImage]});
 expect(result[0].text).not.toContain('base64');
});
test('协议用户图片支持常见格式，同一 item 更新不重复显示',()=>{
 const content=[{type:'image',url:sentImage},{type:'inputImage',imageUrl:secondImage},{type:'input_image',image_url:sentImage}];
 const result=executionTimeline([event(1,'item/started',{item:{id:'u',type:'userMessage',content}}),event(2,'item/completed',{item:{id:'u',type:'userMessage',content}})]);
 expect(result).toHaveLength(1);expect(result[0].images).toEqual([sentImage,secondImage,sentImage]);
});
test('后续缺图片的协议补充不清空已经收到的图片',()=>{
 const result=executionTimeline([event(1,'item/started',{item:{id:'u',type:'userMessage',content:[{type:'image',url:sentImage}]}}),event(2,'item/completed',{item:{id:'u',type:'userMessage',content:[{type:'text',text:'补齐文字'}]}})]);
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({text:'补齐文字',images:[sentImage]});
});
test('不支持的图片仍保留消息和提示，拒绝任意地址与 SVG',()=>{
 const result=executionTimeline([event(1,'user_message',{text:'',attachments:[
  {type:'image',url:'javascript:alert(1)'},{type:'image',url:'https://example.com/track.png'},
  {type:'localImage',path:'/private/image.png'},{type:'image',url:'data:image/svg+xml;base64,AA=='},
  {type:'image',url:'data:image/png;base64,???'},
 ]})]);
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({images:[],unavailableImages:5});
 expect(result[0].text).not.toContain('private');
});

test('空的协议用户补充和旧消息更新不抹掉已显示文字',()=>{
 const result=executionTimeline([
  event(1,'item/started',{item:{id:'u',type:'userMessage',content:[{type:'text',text:'原说明'},{type:'image',url:sentImage}]}}),
  event(2,'item/completed',{item:{id:'u',type:'userMessage',content:[]}}),
  event(3,'assistant_message',{itemId:'a',text:'原回答'}),event(4,'assistant_message',{itemId:'a',text:''}),
 ]);
 expect(result.map(i=>i.text)).toEqual(['原说明','原回答']);
});

test('上下文压缩投影保留协议时间，重复开始不复位、完成不重复',()=>{
 const start=Date.parse('2026-11-04T14:33:24.830Z'),end=Date.parse('2026-11-04T14:36:08.079Z');
 const begin={id:'compact',type:'contextCompaction',startedAtMs:start};
 const active=executionTimeline([event(1,'item/started',{item:begin}),event(2,'item/started',{item:{id:'compact',type:'contextCompaction'}})]);
 expect(active).toMatchObject([{phase:'compaction',status:'inProgress',startedAt:new Date(start).toISOString()}]);
 const done=executionTimeline([event(1,'item/started',{item:begin}),event(2,'item/completed',{item:{...begin,completedAtMs:end}}),event(3,'item/started',{item:begin})]);
 expect(done).toHaveLength(1);expect(done[0]).toMatchObject({phase:'compaction',status:'completed',startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString()});
});
