# Diffwrite

**高度自动化的 Diff 工具。** 把原文、修改和逐句意见放在同一页；AI 可以通过 MCP 读稿、提建议，开启 MCP 模式后也能直接改，页面会自动标出改动。

[下载 Windows 单文件版](https://github.com/SkylerZhu016/Diffwrite/releases/latest)

## 为什么做这个？

我经常要改东西：有时只是删一个字，有时想给一句留个意见，还有时想让 AI 接着改。我没找到一个特别顺手的软件，能把这些动作连起来：边读边改、保留原文、只带走动过的地方，还能让 AI 拿到修改结果。

VS Code 的 Diff 很适合对照两份文件。但审一段稿子时，我往往还没有第二份文件，也不想为了留一句意见先复制原句、再换地方改。Diffwrite 把修改放回正文：删字就在左边按 Delete，右边的改版栏自动跟上；想说为什么改，再在右边写意见。也不用先让 AI 生成、再手动导入，它可以直接把稿件投进来。

## 开始用

1. 下载并双击 **Diffwrite Windows x64**。无需安装 Node.js；程序在系统托盘运行，用默认浏览器打开审稿页。关网页不会断开 MCP，彻底退出请用托盘菜单。
2. 粘贴文本，或拖入 TXT、Markdown、DOCX。左栏可在原文和分句模式间切换；关闭“显示变更”就能通读纯净改稿。右栏分别存意见和改版。
3. 导出纯净改稿、带注 Diff，或直接复制**改动与意见**，不带没动过的正文。稿件自动保存，可从历史记录恢复；也可单独导出审稿备份。

## 让 AI 接上流程

下面说明的是当前源码中的 MCP 流程。GitHub 上的 v0.1.0 仍使用旧流程，尚未包含这些更新。

在右上角打开 **MCP 连接**，为每个 Agent 分别生成连接码，再复制 JSON 配置。MCP 使用无状态 Streamable HTTP，默认只监听本机：`http://127.0.0.1:41732/mcp`。OMP 配置使用 `type: "http"`，不要选旧式 SSE。手写客户端的 POST 请求应同时接受 `application/json` 和 `text/event-stream`；服务器不提供独立 SSE 流。

**MCP 模式**决定是否允许已连接的 AI 写入。开启后，合法且未撤销的连接码可以直接编辑、投稿和管理可恢复的回收站，不再另设逐连接的自动编辑开关；此时网页自带 AI 补全停用。关闭后 MCP 只读，投稿也暂停，网页补全恢复可用。新安装默认关闭，已有连接的旧库首次升级时默认开启。

AI 用 `edit_draft` 把意见和改写直接写入现有输入框，不另建待审卡片。已有人工意见时，AI 的意见附在后面；已有人工改写时，AI 默认把改写建议写到意见栏，只有明确要求覆盖才替换，作者可以点 **换回我的改写**。蓝色标记按意见栏和改版栏分别显示，可单独标为已阅；原文快照保持不变。**保存并通知 AI** 只给选定接收方留增量待办，未被作者改动的 AI 自身写入不会回报给该接收方，也不会主动唤醒 Agent。

关闭 MCP 模式后，可在意见栏设置 OpenAI 兼容的模型服务，再开启默认关闭的 **AI 补全**。停笔一分钟后才生成；切句不触发，空白意见可以手动请求。提示词可编辑，接受、拒绝和后续人工修改可导出为反馈。使用远程模型时，当前句、少量相邻文字和意见前缀会发给你配置的服务。稿件历史和反馈留在本机，默认位于 `%LOCALAPPDATA%\Diffwrite`；模型密钥和 MCP 连接码不经 MCP 读写。

## 自己打包 EXE

在 **Windows x64** 上准备 **Node.js 24 x64、Go 1.25+ 和 7-Zip**。从仓库根目录打开 PowerShell，先跑测试，通过后再打包：

```powershell
node --test
node .\packaging\build-windows.mjs
```

成品是 `dist\Diffwrite.exe`；也可以在打包命令后传一个路径，例如 `".\dist\Diffwrite-test.exe"`。Go 不在 PATH 时设置 `DIFFWRITE_GO`；7-Zip 不在默认目录时设置 `DIFFWRITE_7ZIP`。构建时需要联网读取 Node.js 许可证并下载尚未缓存的 Go 依赖。没有修改 SVG 时，直接用仓库自带的 ICO，无需重新生成。

**让 AI 打包**：把下面这段交给能访问本机仓库并执行命令的 Agent。

> 在 Diffwrite 仓库根目录运行测试，再用打包脚本输出一个新文件名，不覆盖旧版。用独立的临时数据目录、运行时目录和空闲端口验证 EXE 能启动；只停止测试实例，不读取我的稿件库。最后给我成品路径、大小和验证结果。

隔离验证可设置 `DIFFWRITE_REVIEW_DATA`、`DIFFWRITE_REVIEW_RUNTIME`、`DIFFWRITE_REVIEW_PORT`，以 `--no-browser` 启动并检查 `/health`；托盘菜单需要另行实测。改过 `packaging/icon.svg` 后，可用 Chrome 与 Pillow 运行 `python packaging/render-icon.py` 生成 ICO。

## 许可

项目源码使用 [MIT 许可证](LICENSE)。第三方库保留各自许可，详见 [Markdown 依赖](vendor/markdown-licenses.txt) 和 [MCP 依赖](vendor/mcp-licenses.txt)。EXE 内附第三方声明，可用 `--licenses` 查看。
