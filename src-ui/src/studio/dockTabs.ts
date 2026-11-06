export type DockKind='files'|'terminal'|'diff'|'browser'|'launcher';
export type DockTab={id:string;owner:string;kind:DockKind;title:string;pageId?:string};
export type DockState={tabs:DockTab[];active:Record<string,string>};
export const emptyDock=():DockState=>({tabs:[],active:{}});
const titles:Record<DockKind,string>={files:'文件',terminal:'终端',diff:'变更',browser:'新标签页',launcher:'新标签页'};
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
 const selected=next.active[owner];
 const active=target&&(oldActive?.kind==='browser'||pending||!tabs.some(tab=>tab.id===selected))?{...next.active,[owner]:`browser:${owner}:${target}`} : next.active;
 return {tabs:pages.length?tabs.filter(t=>!(t.owner===owner&&t.kind==='browser'&&!t.pageId)):tabs,active};
}

export const maxDockOwners = 128;
export const maxToolTabs = 16;
const layoutKey = 'akb.workspace.tabs.v1';
type DockLayout = { state: DockState; collapsed: Record<string, boolean> };
const persistable = (owner: string) => !owner.startsWith('draft:');

function storageKey() {
  const scope = (window as Window & { akb?: { storageScope?: string } }).akb?.storageScope || 'local';
  return layoutKey + ':' + scope;
}

export function readDockLayout(): DockLayout {
  const blank = { state: emptyDock(), collapsed: {} };
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw || raw.length > 3_500_000) return blank;
    const saved = JSON.parse(raw) as DockLayout;
    const tabs = saved.state.tabs.filter(tab => typeof tab.id === 'string' && tab.id.length <= 256 &&
      typeof tab.owner === 'string' && tab.owner.length <= 128 && persistable(tab.owner) &&
      Object.prototype.hasOwnProperty.call(titles, tab.kind) && typeof tab.title === 'string');
    return { state: { tabs, active: saved.state.active }, collapsed: saved.collapsed };
  } catch { return blank; }
}

export function saveDockLayout(state: DockState, collapsed: Record<string, boolean>) {
  const tabs = state.tabs.filter(tab => persistable(tab.owner) && !(tab.kind === 'browser' && !tab.pageId))
    .map(tab => ({ ...tab, title: tab.title.slice(0, 160) }));
  const owners = new Set(tabs.map(tab => tab.owner));
  const active = Object.fromEntries([...owners].flatMap(owner => state.active[owner] ? [[owner, state.active[owner]]] : []));
  const hidden = Object.fromEntries([...owners].filter(owner => collapsed[owner]).map(owner => [owner, true]));
  const raw = JSON.stringify({ state: { tabs, active }, collapsed: hidden });
  if (owners.size > maxDockOwners || raw.length > 3_500_000) throw new Error('右侧标签记录已达上限');
  if (raw !== localStorage.getItem(storageKey())) localStorage.setItem(storageKey(), raw);
}
