# 会话阅读体验交付 Review

结论：功能、回归、独立复核、可见验收及本机安装通过，无新增用户决策项。

- 用户明确授权：工具调用默认折叠、文本行布局、结束过程折叠与结果分离、Markdown/Mermaid渲染。
- 阶段与来源：phase优先，thread身份去重，WorkRun.thread_id识别主线程；子Agent输出归过程。无turnId用户补充保留事件顺序。
- 兼容：新元数据是前端投影，无DB迁移；不修改任务验收、权限、Agent并发、PTY互斥规则。旧Markdown组件导出入口保留。
- 资源：输出展开才挂载；图表惰性import/视口进入渲染，离开释放并保留比例。资源清单见docs/data-safety/conversation-transcript/resources.json。
- 可观测：语法/限额错误在图表附近提供源码与重试；独立审查的3项P2都有失败后通过证据。
- 可回滚：安装前保留APP备份；SQLite及业务任务没有迁移或删除。
- 验证：217前端测试、TypeScript/Vite、OpenSpec strict、git diff --check；真实浏览器流程图/展开/结束/800px，原生旧会话折叠及文件单例。
- 风格：事件投影保留原始归属；过程投影组织轮次；组件负责展开状态；Mermaid模块持有加载/缓存/在途生命周期。新源码遵循现有TypeScript风格，未整理无关历史文件。

已知边界：老记录无phase/时间戳保守降级；大图有上限；本次截图为隔离样例，原生验证以AX记录为证，不冒充业务执行结果。无会话时浏览器继承既有归属要求。
