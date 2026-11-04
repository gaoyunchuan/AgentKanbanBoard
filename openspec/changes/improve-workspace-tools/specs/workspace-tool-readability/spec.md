## Purpose

让右侧工作区只在有内容时占用空间，让项目终端可靠显示和输入中文，并让 Markdown 文件以可读格式打开，同时保留源码检查能力。

## ADDED Requirements

### Requirement: 无标签自动收起
系统 SHALL 在会话最后一个右侧工具标签关闭后隐藏右侧工作区，并保留可从顶部重新打开工具的入口。

#### Scenario: 关闭最后标签
- **WHEN** 用户关闭当前会话最后一个右侧标签
- **THEN** 右侧工作区不再占据正文空间，顶部工具菜单仍可打开

### Requirement: 终端中文环境
系统 SHALL 为交互终端提供 UTF-8 locale，并使用支持 CJK 字符的字体回退显示中文。

#### Scenario: 中文命令与输出
- **WHEN** 用户在终端输入中文或执行输出中文的命令
- **THEN** 输入和输出均保持可读，不发生乱码

### Requirement: Markdown 文件预览
系统 SHALL 将 `.md` 和 `.markdown` 文件默认渲染为 Markdown，并提供切换源码的入口。

#### Scenario: 打开 Markdown
- **WHEN** 用户打开 Markdown 文件
- **THEN** 标题和强调等结构按 Markdown 显示，用户仍可切换查看原文
