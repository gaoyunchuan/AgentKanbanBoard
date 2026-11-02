# 会话分层阅读验收

## 已交付

- 连续工具调用合并为一行摘要，默认收起；图标按读取、搜索、命令、编辑、智能体、电脑任务分类，悬停出现箭头。展开后每次调用再次独立展开，输出才挂载。
- 运行中显示过程；结束自动折叠为Worked for分钟/秒，分隔线下独立显示最终回答。用户手动展开不会被普通轮询重置。
- 主线程按phase判定最终回答；子Agent输出仅进入过程的智能体组，不冒充主结果。中途user_message即使没有turnId也保留原顺序。
- Markdown使用标准解析和GFM，支持绝对/普通相对文件路径、带括号网页链接、表格和代码块。文件打开右侧文件单例，网页打开右侧独立网页tab。
- Mermaid惰性加载，真实渲染为SVG图片；离开视口释放图片但保留viewBox比例占位，避免回看时页面跳动。错误提供重试和源码入口。
- 正文、过程、工具摘要保持无边框文本行；具体调用展开后才有输出边界。用户输入沿用会话气泡。

## 自动化

- `regression-red.log`：首轮阶段/分组/链接/Mermaid的失败回归。
- `review-red.log`：普通相对链接、子Agent结果、无turnId中途补充的失败回归。
- `scroll-red.log`：图表离开视口后未保留比例的失败回归。
- `frontend-tests.log`：25个文件、217项通过。
- `ui-build.log`：TypeScript及Vite产品构建通过；Mermaid按需分块有大chunk提示，未作为主入口同步加载。
- `spec-validation.log`：OpenSpec strict通过。
- 独立审查发现的3项P2均通过新增回归修复并二次复核通过。最后图表占位修复通过全量217项回归。

## 可见验收

| 场景 | 证据 |
| --- | --- |
| 结束默认折叠，结果、链接、图表独立显示 | completed.png |
| 工具一层展开及具体命令二次展开 | tools-expanded.png |
| 窄窗口800px | completed-800.png；document宽度等于视口800，未横向溢出 |
| 真Mermaid引擎 | 浏览器DOM有complete=true的SVG img，截图可见中文节点与连线；不是单测mock图 |
| 运行→结束 | 实际点击模拟结束后，过程DOM数量0、结果区域1，Worked for 2分钟5秒 |
| 安装应用原会话 | native-transcript.ax.txt：原GPU任务多个Worked for折叠段及2个主结果区域，本地链接正确渲染 |
| 原文件链接点击与重复点击 | native-file-link.ax.txt：右侧proposal.md预览，文件标签始终1个，目录树可收起 |

PNG截图来自真实浏览器运行产品组件的隔离样例，不是业务任务执行结果。样例源码preview.tsx/html保留在验收目录，已从产品源码删除；复现时复制回原临时入口运行。浏览器视口已恢复、验收tab及4192服务器已关闭。

## 安装与清理

安装签名、UI及sidecar SHA见installation.json；备份为安装前保留的APP。本轮纯前端，复用上轮已构建验证的sidecar，依据见reused-sidecar.json；未把前端回归描述成新一轮Rust构建。

更新时停止了“云助手Webterminal不可用”的当前执行，本次未重放业务操作。安装后只打开原会话与文件链接做只读检查。

4个可再生目录已清理，释放约289.2MiB；清理后安装副本签名仍有效，见cleanup.json。

## 边界

- 缺少协议阶段的老记录仅将最后一条无phase回答作为最终结果；明确commentary不会猜成结果。缺少有效时间戳时显示用时未知，不伪造耗时。
- 本地文件仍由现有workspace路径边界检查，链接不会扩大文件访问权限。
- Mermaid输入32Ki字符、300边、4个在途、16项缓存，超过限额或语法错误可查看源码。SVG作为img加载，不把HTML/样式注入主会话DOM；不执行Markdown HTML或危险协议。
- 网页/文件链接的原生验收重点为现有会话；无已选会话时浏览器仍遵循既有会话归属限制。
