import { expect,it } from 'vitest';
import { openTab,closeTab,syncPages,emptyDock } from './dockTabs';
it('reuses the files and changes tabs but keeps independent terminal instances',()=>{
 let state=openTab(emptyDock(),'one','files');state=openTab(state,'one','diff');state=openTab(state,'one','files');
 expect(state.tabs.filter(t=>t.kind==='files')).toHaveLength(1);
 expect(state.active.one).toBe(state.tabs.find(t=>t.kind==='files')?.id);
 state=openTab(state,'one','terminal','term-one');state=openTab(state,'one','terminal','term-two');
 expect(state.tabs.filter(t=>t.kind==='terminal')).toHaveLength(2);
 state=closeTab(state,'term-two');expect(state.active.one).toBe('term-one');
});
it('projects browser targets into the same tab collection without removing other tools',()=>{
 let state=openTab(emptyDock(),'one','files');
 state=syncPages(state,'one',[{id:'a',title:'网页 A'},{id:'b',title:'网页 B'}],'b');
 expect(state.tabs.map(t=>t.kind)).toEqual(['files','browser','browser']);
 state=syncPages(state,'one',[{id:'a',title:'网页 A 更新'}],'a');
 expect(state.tabs).toHaveLength(2);expect(state.tabs.find(t=>t.pageId==='a')?.title).toBe('网页 A 更新');
 expect(state.tabs.find(t=>t.kind==='files')).toBeDefined();
});
it('keeps each conversation collection and selection separate',()=>{
 let state=openTab(emptyDock(),'one','files');state=openTab(state,'two','terminal','term-two');
 expect(state.tabs.filter(t=>t.owner==='one')).toHaveLength(1);
 expect(state.active.one).toContain('files:');expect(state.active.two).toBe('term-two');
});
