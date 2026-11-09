# Diffwrite

**高度自动化的 Diff 工具。** 把原文、修改和逐句意见放在同一页；AI 可以通过 MCP 读稿、提建议，获授权后也能直接改，页面会自动标出改动。

[下载 Windows 单文件版](https://github.com/SkylerZhu016/Diffwrite/releases/latest)

## 为什么做这个？

我经常要改东西：有时只是删一个字，有时想给一句留个意见，还有时想让 AI 接着改。我没找到一个特别顺手的软件，能把这些动作连起来：边读边改、保留原文、只带走动过的地方，还能让 AI 拿到修改结果。

VS Code 的 Diff 很适合对照两份文件。但审一段稿子时，我往往还没有第二份文件，也不想为了留一句意见先复制原句、再换地方改。Diffwrite 把修改放回正文：删字就在左边按 Delete，右边的改版栏自动跟上；想说为什么改，再在右边写意见。也不用先让 AI 生成、再手动导入，它可以直接把稿件投进来。

## 开始用

1. 下载并双击 **Diffwrite Windows x64**。无需安装 Node.js；程序在系统托盘运行，用默认浏览器打开审稿页。关网页不会断开 MCP，彻底退出请用托盘菜单。
2. 粘贴文本，或拖入 TXT、Markdown、DOCX。左栏可在原文和分句模式间切换；关闭「显示变更」就能通读纯净改稿。右栏分别存意见和改版。
3. 导出纯净改稿、带注 Diff，或直接复制**改动与意见**，不带没动过的正文。稿件自动保存，可从历史记录恢复；也可单独导出审稿备份。

## 让 AI 接上流程

在右上角打开 **MCP 连接**，为每个 Agent 分别生成连接码，再复制 JSON 配置。MCP 使用 Streamable HTTP，默认只监听本机：`http://127.0.0.1:41732/mcp`。

普通连接可以读稿、投稿和提交建议。给信任的连接开启 **自动编辑** 后，它还可以直接改稿和意见、管理回收站、读取补全反馈，以及试跑、应用或回退补全提示词。AI 改过的句子会自动变淡蓝，不跳走；同一字段同时被你和 AI 修改时，优先保留你的输入。「保存并通知 AI」只给指定接收方留增量待办，不主动唤醒 Agent。

意见栏还有一个默认关闭的 **AI 补全**：在设置中填 OpenAI 兼容的模型服务，停笔一分钟后才生成；切句不触发，空白意见可以手动请求。提示词可编辑，接受、拒绝和后续人工修改可导出为反馈。使用远程模型时，当前句、少量相邻文字和意见前缀会发给你配置的服务。稿件历史和反馈留在本机，默认位于 `%LOCALAPPDATA%\Diffwrite`；模型密钥和 MCP 连接码不经 MCP 读写。

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
