# @lyw/dsh-qqbot

把 **DSH** 接到 **QQ 官方机器人（QQ Bot API v2）**：在 QQ 里私聊或群里 @ 机器人，
消息会交给一个真实运行的 DSH 会话（能读写文件、跑命令、用工具），回复原路发回 QQ。

```
手机 QQ ──► QQ 开放平台网关(WebSocket) ──► qqbot 网关进程 ──► ACP stdio ──► dsh --profile acp
                    ▲                                                        │
                    └──────────────── QQ 消息回复 ◄──────────────────────────┘
```

## 组成

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Cordis 插件（Host 半）：注册 `qqbot` 设置命名空间、拉起/终止网关子进程、提供配置页与绑定接口 |
| `lib/gateway.mjs` | 常驻网关：QQ 事件 → 会话路由 → ACP → 回复；命令、附件下载、单实例锁、状态文件 |
| `lib/qq-transport.mjs` | QQ Bot API v2 传输层：AppAccessToken、WebSocket identify/心跳/resume/重连、消息发送 |
| `lib/acp-client.mjs` | ACP v1 stdio 客户端：initialize / session(new|resume|close|prompt|cancel)、流式更新、权限应答 |
| `lib/bind.mjs` | 扫码绑定：`create_bind_task` → 二维码 → 轮询 → AES-256-GCM 解出 AppSecret |
| `lib/page.mjs` | 配置页 HTML（状态、扫码绑定、手动填写、重启） |

## 安装

### 1. 下载归档

从 [Releases](https://github.com/Ellery1999/lyw-dsh-qqbot/releases) 下载
`lyw-dsh-qqbot-<version>.tgz`（也可以按下面「从源码构建」自己打包）。

### 2. 装进 profile

```powershell
$tgz = "$env:USERPROFILE\.dsh\profiles\web\vendor\lyw-dsh-qqbot-<version>.tgz"
Copy-Item .\lyw-dsh-qqbot-<version>.tgz (Split-Path $tgz)
dsh plugin --profile web add $tgz
```

### 3. 注册插件行

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾插入：

```yaml
- insert:
    - id: qqbot
      name: '@lyw/dsh-qqbot'
```

### 4. 重启 DSH 并硬刷新浏览器

改完补丁文件后**必须整进程重启** DSH，然后在浏览器里按 **Ctrl+F5**。

> 为什么热挂载不够：web profile 的 `patchReload: live` 只做**配置**热重载。DSH 为 live
> profile 挂的 HMR 实例是 `{ root: [] }`（见 `apps/cli/src/profile-boot.ts`），没有模块根，
> 源码注释写明 *"without replacing source modules"* —— 插件模块不会重新导入；而入口模块
> 按包名经 Node ESM 缓存解析，同路径重挂仍是内存里的旧代码。客户端半（`lib/client.js`）
> 的模块图也只在 web app 启动时扫描一次。所以升级/降级后请重启 DSH，否则你会以为装上了，
> 实际跑的还是旧版本。

### 从源码构建

```powershell
git clone https://github.com/Ellery1999/lyw-dsh-qqbot.git
cd lyw-dsh-qqbot
pnpm pack
```

产出的 `lyw-dsh-qqbot-<version>.tgz` 按上面第 2 步起操作。

## 配置

两种方式等价，都写进同一个设置命名空间：

- **说明设置页**：DSH →「设置 → 插件 → 配置 → qqbot」表单。
- **配置页**：<http://127.0.0.1:3080/plugins/qqbot>（端口取 webServer 实际端口），
  可看连接状态与日志尾巴、一键重启、手动填写。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `appId` | — | QQ 开放平台机器人 AppID |
| `appSecret` | — | AppSecret（`role('secret')`，不在接口里回显） |
| `sandbox` | `false` | 走沙箱域名 `sandbox.api.sgroup.qq.com` / `sandbox.q.qq.com` |
| `workspace` | `$DSH_HOME/qqbot/workspace` | DSH 会话的工作目录 |
| `acpCommand` | `dsh --profile acp` | 启动 ACP agent 的命令行 |
| `autoApprove` | `true` | 自动允许 ACP 权限请求 |
| `allowUsers` / `allowGroups` | `[]` | openid 白名单，留空不限制 |
| `extraPrompt` | — | 追加到每条消息后的要求 |

状态与日志落在 `$DSH_HOME/qqbot/`：`status.json`（连接/会话/统计/最近私聊 openid）、`plugin.json`
（插件挂载现场）、`gateway.log`、`sessions.json`（会话映射）、`attachments/`。

## 白名单怎么填

私聊要填 **user_openid**，群聊要填 **group_openid**，两者是不同的值。三种拿法：

1. **配置页「只允许绑定的 QQ 使用」按钮**（推荐）：白名单为空时按钮就会出现，点击即把
   白名单设为该 openid。优先用扫码绑定记录，没有绑定记录时回退到网关记录的
   「最近私聊发送者 openid」——所以**先给机器人随便发一条消息**（例如 `/help`），
   按钮就能用了，配置页「最近私聊 openid」一行会显示这个值。
2. **在 QQ 里发 `/whoami`**：机器人回复 `会话标识：c2c:<user_openid>`（群里是 `group:<group_openid>`），
   去掉前缀填进白名单。
3. **看 `gateway.log`**：每条入站消息都会记 `key=c2c:<user_openid>` 或 `key=group:<group_openid>`。

`status.json` 里的 `lastUserOpenId` 是网关自己维护的（跨重启保留）。插件的
`plugin.json` 每次 `writeSelf` 是整份覆盖，扫码绑定写入的 `boundUserOpenId` 会被后续
网关启动抹掉，所以兜底身份放在 `status.json`；旧版本没写过该字段时，网关启动会扫描
`gateway.log` 回溯最后一次私聊 openid。

## 扫码绑定

配置页点「生成绑定二维码」→ 手机 QQ 扫码并选择机器人 → AppID/AppSecret 自动写入设置并重启网关。
流程复刻自 Hermes Agent 的 `qqbot/onboard.py`（腾讯未公开的 lite 接口）：

1. `POST https://q.qq.com/lite/create_bind_task` `{"key": base64(32B)}` → `task_id`
2. 二维码内容 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&_wv=2&source=dsh`
3. 每 2s `POST /lite/poll_bind_result` `{"task_id"}` → `status`(1 待扫 / 2 完成 / 3 过期) + `bot_encrypt_secret`
4. `bot_encrypt_secret` = base64(`IV(12) ‖ ciphertext ‖ tag(16)`)，用第 1 步的 key 做 AES-256-GCM 解密得到 client_secret

坑：portal 请求必须带 `Accept: application/json`，否则 q.qq.com 返回反爬挑战页。
若 `connect.html` 拒绝 `source=dsh`，把 `lib/bind.mjs` 里的 `source` 改成 `hermes`。

## QQ 侧命令

| 命令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/new` | 关闭当前会话并清空上下文 |
| `/stop` | 中断正在执行的任务 |
| `/usage` | 上下文用量（`used / size` tokens，来自 ACP `usage_update`） |
| `/status` | 连接 / 模型 / 思考强度 / 用量 / 工作目录 / 会话 id / 统计 |
| `/model` | 列出可选模型（来自 ACP `configOptions`，按组编号） |
| `/model <编号或 provider/model>` | 切换模型（`session/set_config_option`） |
| `/effort` | 列出思考强度可选值 |
| `/effort <编号或值>` | 设置思考强度（low / high / max / 空=默认） |
| `/sessions` | 列出可恢复的 DSH 会话（`session/list`，最近 20 条，带网关自己记的备注） |
| `/switch <编号或 id 前缀>` | 把当前 QQ 会话切换到指定的 DSH 会话（`session/resume`） |
| `/cd <绝对路径>` | 换工作目录，下一条消息在新目录里新建会话 |
| `/whoami` | 当前会话标识（openid / group_openid） |
| `/send <绝对路径>` | 把一个本地文件作为 QQ 附件发给你 |

同一 QQ 会话串行执行；处理中的消息会先回一条「已排队」，超过 20 秒未产出文本会回一条进度。
被动回复受 QQ 限制，且单聊与群聊不同：**单聊 60 分钟 / 4 条**、**群聊 5 分钟 / 5 条**
（重复 `msg_id + msg_seq` 会报 40054005）。超长回复按 1200 字分段，
超预算的全文写入 `$DSH_HOME/qqbot/reply-*.md`。附件也占额度，所以一条回复里
附件优先占位：文本至少留 1 段，剩下的额度给附件。

## 设置页里的卡片

DSH 的「设置 → 插件 → 插件配置」标签只渲染**两个账本的交集**：Host 提供的设置命名空间，
和浏览器端注册到 `settings.plugin.item` 槽位的卡片（见 `dsh-client-ui-settings-plugins`
的 `tab-store` 注释）。所以纯 Host 插件哪怕注册了命名空间也不会出现在设置里——
必须自带浏览器半。

`lib/client.js` 就是那半：它按仓库里 tsdown 产出的 client bundle 格式手写
（`window.__ModuleLoader__.load({ id, factory })`），把 key 为 `qqbot` 的卡片注册进槽位，
卡片再通过 `/plugins/qqbot/api/*` 拉状态、重启网关、收紧白名单。`package.json` 用
`"dsh": { "client": { "platform": "web" } }` 声明它，并导出 `./client`。

**改动客户端半或 `dsh.client` 声明后必须重启 DSH**：客户端模块图在 web app 启动时扫描一次，
热重载只覆盖 bundle 内容变化，不覆盖新出现的 plugin 行。

## 发文件 / 图片给你（出站富媒体）

两个口子，走的都是同一条流水线：

1. **DSH 自己发**：提示词里已经交代了约定 —— 要发文件时，在回复里**单独一行**写
   `[[send:绝对路径]]`（一行一个，最多 3 个）。这一行不会出现在你看到的消息里，
   网关把它摘出来，上传后作为 QQ 附件发出。
2. **你点名要**：`/send <绝对路径>`，不去麻烦模型。

为什么不给 agent 加一个工具：ACP 侧拿不到「我这个会话对应哪个 QQ 会话」，
工具无法自证收件人；而回复文本天然带这个上下文。

**上传走分片**（`upload_prepare` → 逐片 PUT 预签名地址 → `upload_part_finish` →
带 `upload_id` 调 `/files` 合并拿 `file_info` → `msg_type=7`）。不用 URL 直传，
因为那条路要求文件已在公网可访问，而 DSH 手上的文件都在本机；官方也写明分片上传
「适用于大文件或本地文件」。

`file_type` 按扩展名定：`.png/.jpg/.jpeg/.gif/.webp/.bmp` → 1（图片，直接展示）、
`.mp4` → 2、`.silk` → 3，其余一律 4（文件卡片，可下载）。

## 到底有哪些限制（对着 Hermes 核过）

参考实现：`%LOCALAPPDATA%\hermes\hermes-agent\gateway\platforms\qqbot\`
（`adapter.py` / `chunked_upload.py`）。结论是**接口能力和限制跟 Hermes 用的是同一套**，
没有我们多出来的限制：

| 说法 | 实际情况 |
|---|---|
| 「只有 png/jpg 能当图片发」 | **不成立**。官方「富媒体消息概述」列了 jpg/png/gif/webp/bmp；Hermes 的 `send_image_file` 更是对任何图片固定传 `MEDIA_TYPE_IMAGE`，完全不看扩展名。已按五种全放开。 |
| 「URL/`file_data` 直传」 | 有 ~10MB 上限（Hermes 的 `chunked_upload.py` 开头写明），所以大文件和本地文件必须走分片 —— 我们本来就只走分片。 |
| 「单文件大小上限」 | 官方文档写硬限制 200MB；Hermes 定义了 `UploadFileTooLargeError` 但**代码里从没抛出过**，等于不做本地限制。我们保留 200MB 兜底（超了先拦下，省一次白跑的上传）。 |
| **当天发送容量上限** | **这个是真的**：`upload_prepare` 返回 `40093002` =「超过今天发送文件容量上限」，按 bot 计、每天重置。已在网关里翻译成人话并直接回给用户，不重试。 |

分片上传里有个**容易踩的坑**：官方文档说 `parts[].index`「从 0 开始」，
而 Hermes 按 `(part_index - 1) * block_size` 算偏移（等于当作 1 开始）——两者矛盾。
网关的做法是**不押注基准**：序号只用来排序，真正的文件偏移由排序后的累计块大小决定，
回传 `part_index` 时原样透传服务端给的值。响应形状的变体（`data` 包装、
`part_list`、`url`、`part_index`）也都认，`40093001`（分片转存抖动）按服务端下发的
`retry_timeout` 重试，`upload_config.concurrency` 目前不采纳、固定串行。

## 会话标题与备注（为什么以前认不出哪条是哪条）

症状：QQ 建的会话在列表里叫 `[来自 QQ 私聊（user_openid=43D2934C`。

原因有两层，两边都得治：

1. **网页端会话列表**：DSH 的会话标题在没有模型总结时会退化成「提示词前 40 字节」，
   而网关原来的提示词**第一行就是自己加的来源信封**，于是标题被信封占满。现在
   `composePrompt` 把**用户正文放最前面、来源信封挪到最后**，退化的标题至少是用户
   自己说的话（实测从 `[来自 QQ 私聊（user_openid=43D2934C` 变成
   `帮我看看桌面上重保文件夹里`）。零成本，不需要额外模型调用。
2. **QQ 里的 `/sessions`**：ACP 的 `session/list` 只返回 `sessionId` 和 `cwd`，
   **不带标题**，所以这条路只能网关自己记一份。每条会话建立时记下当时那句用户消息
   （截 24 字），按 `sessionId` 存进 `sessions.json` 的 `labels`，`/sessions` 渲染成
   `1. 帮我整理重保日报的告警统计　[e6b94c0f] ← 当前`。

备注的三个规矩：**命令不进备注**（`/help` 不是会话内容）；**只记第一条**，后续对话
不覆盖（备注代表会话的起点）；**按 sessionId 存**，所以 `/switch` 切回来还在。
网页端建的会话没有备注，退回显示 id + 工作目录。

> 顺带一提：`session-title-llm`（模型总结标题）在 ACP 场景下是坏的 —— 请求事件和路由
> 都正常，但标题从不落盘，且 `session-title` 服务在 `work.signal.aborted` 时**静默
> return、连日志都不打**。这属于 DSH 内部问题；现在的做法不依赖它。

## 工作方式与边界
- **每个 QQ 会话 = 一个 DSH ACP 会话**：`c2c:<user_openid>` / `group:<group_openid>`，
  映射存 `sessions.json`，网关重启后用 `session/resume` 续接（已验证）。
- **工具调用**：ACP 的 `session/update` 会带 `tool_call` / `tool_call_update`，
  网关用它们产出进度提示；`session/request_permission` 默认自动允许（`autoApprove`）。
- **附件**：入站附件用 `Authorization: QQBot <token>` 立刻下载到 `attachments/`，
  再把本地路径写进提示词（QQ 的 CDN URL 有时效，必须收到即取）。文件名优先用 QQ 给的
  `filename`，它常常为空，此时按 `content_type` 补扩展名（`image/png` → `.png`），
  否则下游按扩展名判断格式的工具会认不出。图片会在提示词里要求先用 `read_image`
  看图再回答；语音取 `voice_wav_url` 转好的 WAV 落盘（原始 silk DSH 读不了），
  并把 QQ 自带的 `asr_refer_text` 转写一并写进提示词。引用消息（`message_type=103`）
  的附件嵌套在 `msg_elements` 里，会和被引用的正文一起取出来。
- **单实例**：`gateway.lock` 带 20s 心跳，同一台机器上第二个网关会直接退出——
  同一个 AppID 双连接会被 QQ 判为发送过快（4008）。
- **进程生命周期（Windows 上尤其重要）**：DSH 的 `subprocess` 会在子进程外再套一层
  wrapper，`handle.terminate()` 可能只杀掉 wrapper，真正的网关会变成孤儿进程并继续
  占着单实例锁，于是新网关起不来、机器人“看起来连着但已经不受管”。
  因此插件重启网关时先写 `<stateDir>/shutdown.request`（网关每秒检查）并等它自己
  释放锁，超时才 `terminate()`；网关自身还有父进程看门狗（20s 一次），发现宿主消失
  就自行退出。`status.json` 里的 `pid` 是网关自己的 pid，插件句柄上的 pid 可能只是 wrapper。
- **未做**：频道（guild）收发、审批按钮卡片、多机器人实例。
  这些都不影响私聊/群聊对话与收发文件。

## 测试

```powershell
npm run test:unit      # 纯逻辑：分片、纯文本清洗、命令行切分、AES-GCM 解密、二维码 SVG
npm run test:client    # 客户端 bundle 契约：__ModuleLoader__ 注册、槽位 key、react 渲染
npm run test:offline   # 用本地模拟 QQ 平台跑 握手/命令/去重/白名单，不消耗模型额度
npm test               # 完整：再加 真实对话 + 会话持久化 + 群聊 @（会调用模型）
```

当前结果：单测 91/91、离线 e2e 57/57、完整 e2e 29/29
（含 `/usage` `/model` `/effort` `/sessions` `/cd` `/status` 对真实 ACP server 的断言）。
离线 e2e 里的 `[4.5] [4.6]` 覆盖入站附件：带鉴权头下载、按 `content_type` 补扩展名、
语音走 `voice_wav_url`、引用消息里嵌套的附件、中文文件名保留；
`[4.7]–[4.9]` 覆盖出站附件：3MB 文件被切成多片真正 PUT 上来、字节数对得上、
每片都确认、带 `upload_id` 合并、发出 `msg_type=7`、路径不存在时明确报错、
单聊额度不超 4 条。mock QQ 故意把分片**按 1 开始编号**，用来验证网关不依赖
分片序号基准（官方文档说 0 开始，真实 API 实测是 1 开始）。
`[4.95]` 覆盖会话备注：按 sessionId 落盘、命令不被记成备注、后续消息不覆盖。
`/sessions` 的**渲染**逻辑由单测的 `formatSessionList` 用例覆盖 —— ACP 的
`session/list` 只列已持久化的会话，刚建出来的那条往往不在里面，端到端断言押时序会翻车。
`npm run test:client` 需要本机能解析 `react`/`react-dom`（部署的 profile 回退层或 DSH 检出），
解析不到时会明确 SKIP 而不是假通过。

`tests/mock-qq.mjs` 起一个本地 HTTP + WebSocket 服务，实现 token / `/gateway` /
`/v2/*/messages` / op10-hello / op2-identify→READY / op1→op11，于是整条
「QQ 事件 → 会话路由 → ACP → 回复发回 QQ」都能在离线环境断言。实测 15/15 通过
（含真实模型的两轮对话与群聊回复）。

测试用的端点覆盖（也便于指向自建代理）：

| 环境变量 | 作用 |
|---|---|
| `DSH_QQBOT_TOKEN_URL` | 覆盖 `https://bots.qq.com/app/getAppAccessToken` |
| `DSH_QQBOT_API_BASE` | 覆盖 `https://api.sgroup.qq.com` |
| `DSH_QQBOT_EXIT_ON_STDIN_END` | `1` 时把 stdin EOF 当退出信号（插件拉起时设置） |

## 安全提醒

- 白名单（`allowUsers` / `allowGroups`）为空时，**任何**能给机器人发消息的 QQ 用户
  都能驱动 DSH；而 ACP 会话沿用 DSH 的权限预设（本机为 `danger-full-access`），
  等于把文件与命令执行权交给了对方。绑定后建议点配置页的
  **「只允许绑定的 QQ 使用」**（等价于 `allowUsers=[<绑定的 openid>]`）。
  没有扫码绑定记录时，该按钮会用「最近私聊发送者」的 openid——确认提示里会写明
  具体是哪个 openid，点之前先核对一眼。
- 配置页与 `/plugins/qqbot/api/*` 只监听 loopback，但未额外鉴权：本机其他程序
  可读取 AppID 与状态，读不到 AppSecret（接口从不回显）。

## 已知限制

- 设置里的 AppSecret 以明文存于 `$DSH_HOME/settings.yaml`（与 DSH 其他本地设置一致，仅本机可读）。
- 配置页与 `/plugins/qqbot/api/*` 只监听 loopback，但未额外鉴权：本机其他程序可读取 AppID 与状态，
  读不到 AppSecret（接口从不回显）。
- `session/request_permission` 的应答使用 ACP v1 现行格式（`{outcome:{outcome:'selected',optionId}}`），
  不要回退成旧版 `{option, outcome:"allow_once"}`，`@agentclientprotocol/sdk 1.4.0` 会校验失败。
