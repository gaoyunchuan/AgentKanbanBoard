## Context

`RightDock` 由标签状态与 collapsed 状态共同控制；终端输出使用原始字节经 xterm 解码；文件工作区统一按源码预览。

## Goals / Non-Goals

**Goals:** 无标签时不占正文空间；中文输入输出与中文界面一致；Markdown 默认可读且可回看源码。

**Non-Goals:** 不引入新的终端协议、Markdown 编辑或文件转换；不改变权限和项目目录边界。

## Decisions

- 右侧工作区可见性直接包含当前会话标签数，避免关闭后再以额外 effect 修正状态；无标签时按钮打开工具菜单。
- PTY 环境继承有效 UTF-8 `LANG`，否则在 macOS 使用 `en_US.UTF-8`、其他平台使用 `C.UTF-8`，并同步 `LC_CTYPE`；xterm 使用 CJK 字体回退。
- Markdown 文件复用会话里的安全 Markdown 渲染器，默认预览，工具栏图标可切换源码。

## Risks / Trade-offs

- 用户终端 rc 的 locale 覆盖 → PTY 初始环境仍显式 UTF-8，若用户主动覆盖由 shell 负责。
- Markdown 大文件渲染成本 → 保持既有 4 MB 文件读取上限，超限继续提示使用终端。
