export type DockKind='files'|'terminal'|'diff'|'browser';
export type DockTab={id:string;owner:string;kind:DockKind;title:string;pageId?:string};
export type DockState={tabs:DockTab[];active:Record<string,string>};
export const emptyDock=():DockState=>({tabs:[],active:{}});
const titles:Record<DockKind,string>={files:'文件',terminal:'终端',diff:'变更',browser:'新标签页'};
// 文件与变更入口为单例；终端和网页以各自资源身份区分，不能用工具类别去重。
export function openTab(state:DockState,owner:string,kind:DockKind,instance?:string):DockState{
 const id=instance||`${kind}:${owner}`;
 return {tabs:state.tabs.some(t=>t.id===id)?state.tabs:[...state.tabs,{id,owner,kind,title:titles[kind]}],active:{...state.active,[owner]:id}};
}
export function closeTab(state:DockState,id:string):DockState{
 const index=state.tabs.findIndex(t=>t.id===id),closing=state.tabs[index];if(!closing)return state;
 const tabs=state.tabs.filter(t=>t.id!==id),owned=tabs.filter(t=>t.owner===closing.owner);
 const before=state.tabs.slice(0,index).filter(t=>t.owner===closing.owner).slice(-1)[0];
 return {tabs,active:state.active[closing.owner]===id?{...state.active,[closing.owner]:before?.id||owned[0]?.id||'detail'}:state.active};
}
export function syncPages(state:DockState,owner:string,pages:{id:string;title:string}[],target?:string|null):DockState{
 const ids=new Set(pages.map(p=>`browser:${owner}:${p.id}`));
 const oldActive=state.tabs.find(t=>t.id===state.active[owner]);
 let next=state;
 for(const tab of state.tabs)if(tab.owner===owner&&tab.kind==='browser'&&tab.pageId&&!ids.has(tab.id))next=closeTab(next,tab.id);
 const tabs=[...next.tabs];
 for(const page of pages){const id=`browser:${owner}:${page.id}`,index=tabs.findIndex(t=>t.id===id),tab:DockTab={id,owner,kind:'browser',pageId:page.id,title:page.title||'新标签页'};if(index>=0)tabs[index]=tab;else tabs.push(tab)}
 const pending=tabs.find(t=>t.owner===owner&&t.kind==='browser'&&!t.pageId);
 const active=target&&(oldActive?.kind==='browser'||pending)?{...next.active,[owner]:`browser:${owner}:${target}`} : next.active;
 return {tabs:pages.length?tabs.filter(t=>!(t.owner===owner&&t.kind==='browser'&&!t.pageId)):tabs,active};
}
