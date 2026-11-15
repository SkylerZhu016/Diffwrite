# Diffwrite

**高度自动化的 Diff 工具。** 把原文、修改和逐句意见放在同一页；AI 可以通过 MCP 读稿、提建议，开启 MCP 模式后也能直接改，页面会自动标出改动。

[下载 Windows 单文件版](https://github.com/SkylerZhu016/Diffwrite/releases/latest) · [更新记录](CHANGELOG.md)

## 为什么做这个？

我经常要改东西：有时只是删一个字，有时想给一句留个意见，还有时想让 AI 接着改。我没找到一个特别顺手的软件，能把这些动作连起来：边读边改、保留原文、只带走动过的地方，还能让 AI 拿到修改结果。

VS Code 的 Diff 很适合对照两份文件。但审一段稿子时，我往往还没有第二份文件，也不想为了留一句意见先复制原句、再换地方改。Diffwrite 把修改放回正文：删字就在左边按 Delete，右边的改版栏自动跟上；想说为什么改，再在右边写意见。也不用先让 AI 生成、再手动导入，它可以直接把稿件投进来，新稿进入右上角历史记录，并弹出提示，不打断当前审稿。

## 开始用

1. 下载并双击 **Diffwrite Windows x64**。无需安装 Node.js；程序在系统托盘运行，用默认浏览器打开审稿页。关网页不会断开 MCP，彻底退出请用托盘菜单。
2. 在空白页直接按 **Ctrl+V**，或拖入 TXT、Markdown、DOCX。导入带注 MD 或 TXT 会创建新稿件；在已有稿件正文里粘贴带注原文，则插入当前光标或替换选区，不另开稿件。两种入口都会还原意见、改写和删除，并识别 Markdown。
3. 在分句模式点击一句，就地编辑本句源码；文字继续按原段落自然跨行，描边跟随每行文字，其他正文保持预览。正文完整行两端对齐，末行不拉满。点击空行可定位光标并删除空白，不弹出空白框；在句首按 Backspace、句尾按 Delete 也可删除相邻换行。一个 **Enter** 换行，在句尾连续两个 **Enter** 新建独立段落，光标直接进入新段，意见和改版单独保存。Markdown 预览保留正文换行和连续空行。可跨句、跨段拖选后按 **Delete**，拖选跨出编辑框时会转为正文选区。**Ctrl+Z** 撤销，**Ctrl+Shift+Z** 重做；原文快照和已有意见保留。
4. 导出纯净改稿、带注 Diff，或直接复制**改动与意见**，不带没动过的正文。稿件自动保存，可从历史记录恢复；也可单独导出审稿备份。

## 让 AI 接上流程

下面说明的是当前源码中的 MCP 流程；连接其他版本的 EXE 时，以 `tools/list` 返回的工具及参数为准。

在右上角打开 **MCP 连接**，为每个 Agent 分别生成连接码，再复制 JSON 配置。MCP 使用无状态 Streamable HTTP，默认只监听本机：`http://127.0.0.1:41732/mcp`。OMP 配置使用 `type: "http"`，不要选旧式 SSE。手写客户端的 POST 请求应同时接受 `application/json` 和 `text/event-stream`；服务器不提供独立 SSE 流。

**MCP 模式**决定是否允许已连接的 AI 写入。开启后，合法且未撤销的连接码可以直接编辑、投稿和管理可恢复的回收站，不再另设逐连接的自动编辑开关；此时网页自带 AI 补全停用。关闭后 MCP 只读，投稿也暂停，网页补全恢复可用。新安装默认关闭，已有连接的旧库首次升级时默认开启。

AI 用 `edit_draft` 把意见和改写直接写入现有输入框，不另建待审卡片。已有人工意见时，AI 的意见附在后面；已有人工改写时，AI 默认把改写建议写到意见栏，只有明确要求覆盖才替换，作者可以点 **换回我的改写**。蓝色标记按意见栏和改版栏分别显示，可单独标为已阅；原文快照保持不变。**保存并通知 AI** 只给选定接收方留增量待办，未被作者改动的 AI 自身写入不会回报给该接收方，也不会主动唤醒 Agent。

通知按稿件和收件人分别计算，不定时推送，也不重复发送未变正文。文件导入、审稿备份和带注旧稿粘贴自带的意见、改写、删除与空白变化作为已有状态；之后的人工编辑才进入增量。粘贴只排除本次导入，不会清掉此前尚未通知的修改。普通粘贴新文字仍算编辑。读取不会推进通知起点；成功发送会推进，旧待办在 AI 确认处理前仍可读取。此规则从本版之后的导入生效，既有待办不会被自动清除。

关闭 MCP 模式后，可在意见栏设置 OpenAI 兼容的模型服务，再开启默认关闭的 **AI 补全**。停笔一分钟后才生成；切句不触发，空白意见可以手动请求。提示词可编辑，接受、拒绝和后续人工修改可导出为反馈。使用远程模型时，当前句、少量相邻文字和意见前缀会发给你配置的服务。稿件历史和反馈留在本机，默认位于 `%LOCALAPPDATA%\Diffwrite`；模型密钥和 MCP 连接码不经 MCP 读写。

## 给 AI：如何连接和调用 MCP

### 先拿完整连接信息

请用户在 **MCP 连接 → 复制连接信息** 中复制完整 JSON。使用其中的 `url` 和 `headers.Authorization`；认证值已经包含 `Bearer `，不要再拼一次。只有连接码而没有地址时，先索取完整 JSON，不要猜端口。

如果客户端支持 MCP 配置，把服务条目接入客户端的 **Streamable HTTP** 连接，再使用它暴露的工具。粘贴 JSON 到聊天里并不等于客户端已经加载了配置；以实际成功列出工具为准。

如果当前会话没有已注册的 MCP 工具，但你能在用户电脑上发 HTTP 请求，也可以直接按下面的协议调用，无需控制浏览器或安装 MCP SDK。云端环境中的 `127.0.0.1` 指向云端自己，不能据此访问用户电脑；不要为了连接擅自开放公网端口。

### 用 JSON-RPC 验证连接

所有请求都 **POST 到复制信息里的同一个 URL**，例如默认的 `http://127.0.0.1:41732/mcp`。不要把工具名拼在 URL 后面，也不要把 `mcpServers` 配置当成请求体。

每次 POST 都带以下请求头；认证值使用用户提供的配置：

```http
Authorization: Bearer <MCP连接码>
Content-Type: application/json
Accept: application/json, text/event-stream
```

先发送初始化请求：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "writing-agent", "version": "1.0" }
  }
}
```

读取响应的 `result.protocolVersion`，后续请求增加 `MCP-Protocol-Version` 请求头，值使用协商返回的版本。再发送初始化完成通知，**不带 `id`**：

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

这一步正常返回 HTTP 202、空响应体，不要对空响应执行 JSON 解析。随后获取工具及其参数定义：

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

再做一次只读调用，确认能访问稿件库：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list_drafts",
    "arguments": { "offset": 0, "limit": 10 }
  }
}
```

当前服务无状态，不要求保存 `Mcp-Session-Id`，也不提供独立 SSE 监听流；GET `/mcp` 返回 405 不代表 POST 调用失败。普通调用返回 JSON：先检查顶层 `error`，再检查 `result.isError`。工具数据优先读取 `result.structuredContent`，兼容客户端也可解析 `result.content` 中的文本 JSON。**HTTP 200 不一定代表工具执行成功。**

### 读稿、改稿和投递新稿

后续仍用 `tools/call`，替换 `params.name` 与 `params.arguments`。每个 JSON-RPC 请求使用新的 `id`；写入工具里的 `requestId` 是另一个标识，用于防止重复执行。

**读现有稿件**：从 `list_drafts` 选择用户指定的稿件 ID，调用 `read_draft`，参数如 `{"draftId":"实际稿件ID","offset":0,"limit":30}`。用返回的 `next` 继续分页，直到为 `null`。粘贴和插段会改变句块编号，修改前必须重新读取。

**读全部已有修订**：直接用 `read_draft`，可将 `limit` 设为 100 并读完所有分页，再筛选有意见、改写或删除的句块。导入或粘贴恢复的旧批注也能读取，不需要作者先发送通知；通知队列只列出指定收件人的待办，不能用它代替全稿修订查询。这里读取的是原句与当前修订状态，不是每一次编辑的操作时间线。

**改现有稿件**：先取得最新 `meta.revision` 和目标句块，再调用：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "edit_draft",
    "arguments": {
      "requestId": "unique-edit-001",
      "draftId": "actual-draft-id",
      "expectedRevision": 7,
      "edits": [
        {
          "sentence": 0,
          "original": "原句。",
          "opinion": "这句的动作关系需要更清楚。",
          "replacement": "改写后的句子。"
        }
      ]
    }
  }
}
```

示例中的稿件 ID、版本、编号和原句必须替换为刚读到的值。`sentence` 从 0 开始，`original` 必须逐字匹配返回的原文，不能拿 `effective` 代替。只写意见就省略 `replacement`，只改正文就省略 `opinion`。删除整句用 `deleted:true`；`replacement:""` 是恢复原句，不是删除。

检查返回的 `changed` 和 `keptHuman`。已有人工改写时默认不覆盖；只有作者明确授权覆盖该句，才传 `overwriteHumanRevision:true`。每次新的操作生成唯一 `requestId`（建议 UUID，不要复用示例值）。**发送结果不明时，用相同 requestId 和完全相同的参数重试**。若明确返回版本冲突，则重新读取、避让用户的新修改，并用新的 requestId 提交新请求。

**投递新稿件**：调用 `publish_draft`，例如：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "publish_draft",
    "arguments": {
      "requestId": "unique-publish-001",
      "title": "待审稿.md",
      "text": "# 待审稿\n\n正文内容。",
      "format": "markdown"
    }
  }
}
```

它创建独立稿件，不追加到正在审的稿件里。成功后保留返回的 `id`，前端会把新稿加入历史记录并提示作者。此工具接收正文，不解析导入专用的 `<意见：…>`、`<改为：…>` 标记；AI 写批注应使用 `edit_draft`。

本版读取每页最多 100 句，`edit_draft` 每批最多修改 100 句。连续写入时每批都使用更新后的稿件版本；其他限制以当前 `tools/list` 为准。

### 接收作者通知，不反复拉取全文

作者点击 **保存并通知 AI** 后，通知进入所选连接的待办队列；不会主动往聊天发送消息，也不会唤醒已经停止运行的 Agent。

先调用 `list_review_notifications`（如 `{"limit":30}`），再调用 `read_review_notification`（如 `{"notificationId":"实际通知ID","offset":0,"limit":30}`），按返回的 `next` 分页。只有需要上下文或准备写入时才补读相关句块。通知携带变动句块的当前状态，不是每次按键的操作日志。

如果用户要求监听，在当前任务运行期间每隔 2～5 秒轮询，并用通知 ID 区分新旧。完成该项跟进，或用户明确确认已处理后，再调用 `ack_review_notification`，参数为 `{"notificationId":"实际通知ID"}`。不能只请求一次就声称持续监听，也不要把未确认的旧待办当成新通知。

`changeCount` 包含句块、空白和结构变化，不等于意见条数。结合 `changes`、`gapChanges`、`structureChanged` 判断；`restored` 是恢复原句，`opinionCleared` 是清空意见。零变化不会创建通知，不能仅凭没收到通知就断言用户已点击发送。

### 遇到错误先定位这一层

- **连接拒绝**：核对程序是否启动、复制的地址，以及执行 HTTP 请求的电脑是否正确。
- **401**：认证头缺失或连接码无效，重新取得该连接的完整 JSON；这里不用模型服务的 API Key。
- **406**：检查 `Accept` 是否同时包含 `application/json, text/event-stream`。
- **404 或工具不存在**：确认路径为 `/mcp`，重新 `tools/list`，不要沿用旧版工具名。
- **MCP 模式未开启**：继续读取即可；写入和确认处理需作者在页面开启 MCP 模式。
- **稿件版本冲突**：重读最新内容后再提交，不要重复覆盖旧版本。

## 本机共用数据

源码、CMD 和 EXE 都读取 `%LOCALAPPDATA%\Diffwrite\launch.json` 中的本机启动偏好。可设置 `dataDirectory`（现有数据目录的绝对路径）和 `port`（本机端口）；不配置时使用默认目录与端口。这个文件在仓库外，不随 EXE 打包，更新程序不会搬走稿件或覆盖个人配置。不同入口使用同一配置即可共用历史、批注与 MCP 连接。

用于隔离测试的 `DIFFWRITE_REVIEW_DATA`、`DIFFWRITE_REVIEW_PORT` 环境变量优先于本机配置。配置损坏会报错，不会悄悄创建另一份空稿件库。

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
