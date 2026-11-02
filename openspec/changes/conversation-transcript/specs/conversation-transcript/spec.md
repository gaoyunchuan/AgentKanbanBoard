## ADDED Requirements
### Requirement: 工具调用分层且默认收起
系统 SHALL 将同一过程内连续工具调用合并为无边框文本行，以图标/颜色区分类别；默认收起，展开后各命令和工具再次独立展开。

#### Scenario: 连续读取与命令
- **WHEN** 连续发生文件读取和命令执行
- **THEN** 默认仅有一条摘要，点击后显示各调用，再点击才显示输出

### Requirement: 过程与结果按阶段隔离
系统 SHALL 保留协议阶段，运行中显示过程，执行结束自动折叠为Worked for时长，分割线下独立展示最终回答。

#### Scenario: 流式执行结束
- **WHEN** 当前Turn由执行中变为完成
- **THEN** 过程收起，最终回答保持可见，用户能展开过程

### Requirement: 富文本与流程图正确显示
系统 SHALL 渲染Markdown网页/本地文件链接和Mermaid流程图，不执行嵌入HTML或危险链接；错误流程图提供源码入口。

#### Scenario: 点击文件与网页
- **WHEN** 用户点击Markdown链接
- **THEN** 文件复用文件工具tab，网页打开右栏独立tab

#### Scenario: 流程图
- **WHEN** 完整Mermaid代码可解析
- **THEN** 展示真实流程图，保留查看源码入口
