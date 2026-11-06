const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const {EventEmitter}=require('node:events');
function fixture(options = {}){
 const children=new Set(),views=[],events=[];class View{constructor(options){if('webContents' in options)assert.ok(options.webContents instanceof EventEmitter,'options.webContents must be a WebContents');this.options=options;this.loads=[];this.url='about:blank';views.push(this);this.webContents=options.webContents||new EventEmitter();Object.assign(this.webContents,{session:{setDownloadPath(){},setPermissionCheckHandler(){},setPermissionRequestHandler(){}},setWindowOpenHandler:handler=>{this.open=handler},loadURL:async(url,options)=>{this.loads.push({url,options});this.url=url},getURL:()=>this.url,getTitle:()=>'',close:()=>this.webContents.emit('destroyed')})}setBounds(){}}
 const window={on(){},webContents:{send(channel,value){events.push({channel,value})}},contentView:{addChildView:v=>children.add(v),removeChildView:v=>children.delete(v)}};
 const module={exports:{}};const context={module,exports:module.exports,__dirname:path.join(__dirname,'../desktop/lib'),process,URL,console,require:name=>name==='electron'?{WebContentsView:View}:name==='node:fs'&&!options.manifest?{mkdirSync(){}}:name.startsWith('.')?require(path.join(__dirname,'../desktop/lib',name)):require(name)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/lib/browser-manager.js'),'utf8'),context);
 return {manager:new module.exports.BrowserManager(window,options),children,views,events};
}
test('background agent page activation cannot cover files or terminals after the browser is hidden',()=>{
 const {manager,children}=fixture();manager.handle('one','new_page');assert.equal(children.size,0);
 manager.setRect('one',{x:200,y:100,width:600,height:500});assert.equal(children.size,1);
 manager.hide();assert.equal(children.size,0);manager.handle('one','new_page');assert.equal(children.size,0);
 manager.setRect('one',{x:200,y:100,width:600,height:500});assert.equal(children.size,1);
});
test('switching browser owners displays only one native view',()=>{
 const {manager,children}=fixture();manager.handle('one','new_page');manager.setRect('one',{x:200,y:100,width:600,height:500});
 manager.handle('two','new_page');manager.setRect('two',{x:200,y:100,width:600,height:500});assert.equal(children.size,1);
});

test('status polling does not recreate a webpage after its final tab was closed',()=>{
 const {manager}=fixture();manager.handle('one','new_page');const target=manager.state('one').target_id;manager.handle('one','close_page',{target_id:target});
 assert.equal(manager.handle('one','status').pages.length,0);assert.equal(manager.handle('one','list_pages').pages.length,0);
});

test('完成会话时销毁其全部网页并清理恢复记录，保留其他会话', () => {
 const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'akb-browser-release-'));
 const options = { manifest: path.join(dir, 'tabs.json'), downloads: dir };
 try {
  const {manager, views, children, events} = fixture(options);
  manager.newTab('done', 'https://example.com/one');
  manager.newTab('done', 'https://example.com/two');
  manager.newTab('other', 'https://example.com/other');
  manager.setRect('other', {x:200,y:100,width:600,height:500});
  const oldRevision = manager.state('done').revision;
  let destroyed = 0;
  for (const view of views.slice(0, 2)) view.webContents.once('destroyed', () => destroyed++);
  manager.releaseConversation('done');
  assert.equal(destroyed, 2);
  assert.ok(events.at(-1).value.revision > oldRevision);
  assert.equal(manager.state('done').pages.length, 0);
  assert.ok(children.has(views[2]));
  manager.dispose();
  const {manager: restored} = fixture(options);
  assert.equal(restored.state('done').pages.length, 0);
  assert.equal(restored.state('other').pages.length, 1);
  restored.dispose();
 } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test('网页新窗口请求创建同会话标签，原页面保留且交由 Electron 执行原始导航',()=>{
 const {manager,views,children}=fixture();manager.newTab('one','https://example.com/source');manager.setRect('one',{x:200,y:100,width:600,height:500});
 assert.equal(typeof views[0].open,'function');
 const response=views[0].open({url:'https://example.com/child',disposition:'new-window',postBody:{data:[{bytes:Buffer.from('value=test')}]},referrer:{url:'https://example.com/source'}});
 assert.equal(response.action,'allow');assert.equal(response.outlivesOpener,true);
 const guest=new EventEmitter();const contents=response.createWindow({webContents:guest,webPreferences:{openerId:42}});
 assert.equal(contents,guest,'Electron 38 要求返回它预创建的 guest，不能另造 WebContents');
 assert.equal(contents,views[1].webContents);assert.equal(children.size,1);
 assert.equal(manager.state('one').pages.length,2);assert.equal(manager.state('one').target_id,'tab-2');assert.equal(views[0].url,'https://example.com/source');
 assert.equal(views[1].loads.length,0,'不能手动 loadURL 重放为 GET，Electron 需保留 POST/referrer/opener');
 assert.equal(views[1].options.webPreferences.openerId,42);assert.equal(views[1].options.webPreferences.partition,views[0].options.webPreferences.partition);
 assert.equal(response.overrideBrowserWindowOptions.webPreferences.nodeIntegration,false);assert.equal(response.overrideBrowserWindowOptions.webPreferences.contextIsolation,true);assert.equal(response.overrideBrowserWindowOptions.webPreferences.sandbox,true);
 assert.equal(typeof views[1].open,'function','新标签也必须接管后续窗口请求');
});

test('没有预创建 guest 的新标签请求需要按原始参数导航',()=>{
 const {manager,views}=fixture();manager.newTab('one','about:blank');
 assert.equal(typeof views[0].open,'function');
 const postBody={data:[{type:'rawData',bytes:Buffer.from('message=test')}],contentType:'application/x-www-form-urlencoded'};
 const referrer={url:'https://example.com/source',policy:'strict-origin-when-cross-origin'};
 const response=views[0].open({url:'https://example.com/child',disposition:'background-tab',postBody,referrer});
 response.createWindow({webPreferences:{}});
 assert.equal(views[1].loads.length,1);assert.equal(views[1].loads[0].url,'https://example.com/child');
 assert.equal(views[1].loads[0].options.httpReferrer,referrer);assert.equal(views[1].loads[0].options.postData,postBody.data);
 assert.equal(views[1].loads[0].options.extraHeaders,'content-type: application/x-www-form-urlencoded');
});

test('网页自行关闭后移除标签，并恢复原网页',()=>{
 const {manager,views,children}=fixture();manager.newTab('one','about:blank');manager.setRect('one',{x:200,y:100,width:600,height:500});manager.newTab('one','about:blank');
 views[1].webContents.emit('destroyed');
 assert.equal(manager.state('one').pages.length,1);assert.equal(manager.state('one').target_id,'tab-1');assert.equal(children.size,1);
});

test('隐藏会话的窗口请求不抢显示，禁用不支持的地址',()=>{
 const {manager,views,children}=fixture();manager.newTab('one','about:blank');manager.hide();
 assert.equal(typeof views[0].open,'function');
 for(const url of ['javascript:alert(1)','file:///private/test','https://user:password@example.com'])assert.equal(views[0].open({url}).action,'deny');
 assert.equal(manager.state('one').pages.length,1);
 const response=views[0].open({url:'about:blank'});response.createWindow({webPreferences:{}});
 assert.equal(manager.state('one').pages.length,2);assert.equal(children.size,0);
});


test('重启只恢复网址与选中项，按需加载且关闭项不再出现', () => {
 const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'akb-browser-tabs-'));
 const options = { manifest: path.join(dir, 'tabs.json'), downloads: dir };
 try {
  const { manager } = fixture(options);
  const first = manager.newTab('one', 'https://example.com/one');
  const second = manager.newTab('one', 'https://example.com/two');
  manager.handle('one', 'navigate', { target_id: second, url: 'https://example.com/updated' });
  manager.handle('one', 'close_page', { target_id: first });
  manager.dispose();
  const restored = fixture(options);
  assert.equal(restored.views.length, 0);
  assert.equal(restored.manager.handle('one','status').pages[0].url, 'https://example.com/updated');
  assert.equal(restored.manager.handle('one','status').target_id, second);
  assert.equal(restored.manager.handle('one','status').pages.length, 1);
  assert.equal(restored.manager.handle('two','status').pages.length, 0);
  restored.manager.setRect('one',{x:200,y:100,width:600,height:500});
  assert.equal(restored.views.length, 1);
  assert.equal(restored.views[0].loads[0].url, 'https://example.com/updated');
  restored.manager.dispose();
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('后台网页回收有上限且保留元数据，不销毁前台或 Agent 使用的网页', async () => {
 const { manager } = fixture({ viewLimit: 3 });
 manager.newTab('front','https://example.com/front');
 manager.setRect('front',{x:200,y:100,width:600,height:500});
 manager.newTab('agent','https://example.com/agent');
 manager.newTab('old','https://example.com/old');
 await manager.withConversation('agent',async()=>{
  manager.newTab('new','https://example.com/new');
  assert.equal(manager.liveViews().length,3);
  assert.ok(manager.activeContents('front'));
  assert.ok(manager.activeContents('agent'));
  assert.equal(manager.activeContents('old'),null);
  assert.equal(manager.state('old').pages[0].url,'https://example.com/old');
 });
 manager.setRect('old',{x:200,y:100,width:600,height:500});
 assert.equal(manager.activeContents('old').getURL(),'https://example.com/old');
 assert.equal(manager.liveViews().length,3);
});

for (const binding of [{key:'x',shift:true},{key:'w',shift:false}]) test(`原生网页 ${binding.shift?'Shift+':''}${binding.key} 只转发一次关闭，并拦截页面和菜单处理`,()=>{
 const { manager, views, events } = fixture();
 manager.newTab('one','about:blank');
 manager.setRect('one',{x:200,y:100,width:600,height:500});
 manager.setShortcuts({sidebar:'B',newTab:'T',close:'Shift+X'});
 let prevented=0;
 const input={type:'keyDown',...binding,...(process.platform==='darwin'?{meta:true}:{control:true})};
 views[0].webContents.emit('before-input-event',{preventDefault:()=>prevented++},input);
 views[0].webContents.emit('before-input-event',{preventDefault:()=>prevented++},{...input,isAutoRepeat:true});
 assert.equal(prevented,2);
 assert.equal(events.filter(event=>event.channel==='workspace:shortcut').length,1);
 assert.equal(events.at(-1).value.action,'close');
 assert.equal(events.at(-1).value.conversationId,'one');
});
