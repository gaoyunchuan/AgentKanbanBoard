## Purpose

本地Docker运行会话独立的headless Chrome，人和Agent通过agent-browser操作同一页面，APP通过streaming展示。

## ADDED Requirements

### Requirement: 会话绑定独立浏览器

系统 SHALL 按需将一个活跃会话绑定到独立Chrome容器及agent-browser session，所有页面操作 SHALL 从后端归属映射解析目标，不自动发现通用Chrome/Arc或接受其它owner endpoint。

#### Scenario: 人与Agent共用页面
- **WHEN** 用户在A会话面板打开页面并让Agent查看
- **THEN** Agent列出的targets与A面板相同，读取真实页面内容，操作结果在同一面板可见

#### Scenario: 会话隔离与故障
- **WHEN** A/B同时浏览或A连接失效
- **THEN** 页面、Cookie与输入不串会话；失效明确报错，不切到B或外部浏览器

### Requirement: streaming展示与页面管理

面板 SHALL 使用agent-browser WebSocket streaming展示画面、发送输入，提供地址栏、导航和页面新建/切换/关闭。中文输入、剪贴板和文件操作 SHALL 经过真实客户端验证。

#### Scenario: 画面变慢与切换
- **WHEN** 客户端暂停绘制、切会话或切页
- **THEN** 有界丢弃旧帧，ACK来自最终呈现端；旧owner/target/viewport输入拒绝，旧帧不冒充新页

#### Scenario: 常用交互
- **WHEN** 用户输入中文、选择文字、复制粘贴、操作网页控件或传输文件
- **THEN** 真实页面内容/行为/文件哈希符合操作，不能以CLI命令支持代替APP功能通过

### Requirement: 既有会话工具接入

升级后的既有Thread SHALL 能访问自己新打开的浏览器页面，保留身份、历史、目录和权限。工具接入 SHALL 不依赖旧browser_enabled冻结值。

#### Scenario: 旧Thread使用浏览器
- **WHEN** 用户恢复旧Thread并打开面板页面
- **THEN** 无需重建会话即可通过会话绑定工具读取和操作该页面

### Requirement: 人工操作与有界生命周期

系统 SHALL 串行化同owner变更并支持人工接管，限制容器、页面、帧、命令和临时传输文件。隐藏面板 SHALL 只停流；关闭浏览器/APP SHALL 回收自有运行资源，聊天历史保留。

#### Scenario: 接管和交还
- **WHEN** 用户接管浏览器后交还Agent
- **THEN** 人工期间Agent变更停止派发，交还后重读页面，不重放旧提交

#### Scenario: 退出和配额
- **WHEN** APP退出、异常恢复或资源超限
- **THEN** 只清理本APP精确归属资源；超限明确拒绝浏览器操作，普通聊天可继续；持久profile不被清理

### Requirement: 本机开发页和真实验收

容器 SHALL 能按明确宿主路由访问用户指定的本机开发服务，包含WS/HMR和文件。发布 SHALL 通过test-plan的G01–G03和B01–B10，记录实际结果与边界。

#### Scenario: 开发页验收
- **WHEN** 本机开发服务仅监听127.0.0.1
- **THEN** 通过经验证的Docker宿主路由或有限端口转发访问，不靠暴露公网或读取个人浏览器代替

### Requirement: 浏览器状态随数据库持久保存

完整Chrome profile、下载文件与有版本的页面恢复信息 SHALL 写入实际已打开数据库所在目录下的独立数据库/owner子目录，并bind mount进容器。系统 SHALL 在APP升级、Docker重启、容器重建后恢复已保存状态，停止运行 SHALL NOT 删除持久状态。

#### Scenario: 容器重建与应用升级
- **WHEN** 保存Cookie、localStorage、IndexedDB和页面列表后重建容器或升级APP
- **THEN** 从同一DB旁目录恢复实际状态及页面；重新绑定targets，禁止重放未知提交；不能只以状态文件存在判定通过

#### Scenario: 路径与单写者
- **WHEN** 应用绑定不同数据库路径、两个会话同时启动或恢复遇到损坏manifest
- **THEN** 状态按实际DB与owner隔离，同profile单写者；坏文件保留并报错，不能回退HOME、清空profile或静默覆盖
