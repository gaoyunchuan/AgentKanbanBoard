const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');const {EventEmitter}=require('node:events');
function fixture(){
 const children=new Set(),views=[];class View{constructor(options){if('webContents' in options)assert.ok(options.webContents instanceof EventEmitter,'options.webContents must be a WebContents');this.options=options;this.loads=[];this.url='about:blank';views.push(this);this.webContents=options.webContents||new EventEmitter();Object.assign(this.webContents,{session:{setDownloadPath(){}},setWindowOpenHandler:handler=>{this.open=handler},loadURL:async(url,options)=>{this.loads.push({url,options});this.url=url},getURL:()=>this.url,getTitle:()=>'',close:()=>this.webContents.emit('destroyed')})}setBounds(){}}
 const window={on(){},webContents:{send(){}},contentView:{addChildView:v=>children.add(v),removeChildView:v=>children.delete(v)}};
 const module={exports:{}};const context={module,exports:module.exports,process,URL,require:name=>name==='electron'?{WebContentsView:View}:name==='node:fs'?{mkdirSync(){}}:require(name)};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../desktop/lib/browser-manager.js'),'utf8'),context);
 return {manager:new module.exports.BrowserManager(window),children,views};
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
