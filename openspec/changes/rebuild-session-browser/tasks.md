## 0. 设计与契约

- [x] 0.1 根据2026-10-29用户选择收敛为本地Docker headless Chrome＋agent-browser streaming，更新设计、规格和验收计划。
- [x] 0.2 简洁方案已获用户确认且builder无重要缺口；固定可用sidecar/镜像版本，验证G01–G03；未通过先修订具体适配。

## 1. 最小功能闭环

- [x] 1.0 新增browser_state.rs、Repository实际DB派生目录与持久manifest/锁测试；RED→GREEN，覆盖DB路径切换及重开恢复。

- [x] 1.1 实现会话owner到容器/session/targets的一对一管理与薄桥接；先写B01–B03失败测试；完整profile及原子页面manifest保存于实际DB旁，单profile文件锁。
- [x] 1.2 打通真实“人开页→Agent列页/读标记→Agent操作→人看见”，无通用浏览器回退。

## 2. APP接入

- [x] 2.1 替换900ms截图为streaming，接页面列表与地址/导航；处理来源、ACK、目标切换、输入法、剪贴板和文件。
- [ ] 2.2 修复既有Thread工具接入并验证B04；完成B05–B10及真实WKWebView验收。（B04/B05/B06/B07/B10 已取证；B09 p95/fps 与 4 容器满载仍未测）

## 3. 交付

- [x] 3.1 适用回归、独立review、资源约束/清理验证、构建与签名；回填真实证据。
- [ ] 3.2 核对正式活动执行及草稿后安装本机候选版，验证原有任务/权限/执行状态不变。
