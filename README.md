# @lyw/dsh-qqbot

把 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 接到 **QQ 官方机器人（QQ Bot API v2）**：
在 QQ 里私聊机器人、或在群里 @ 它，消息会交给一个**真实运行的 DSH 会话**（能读写文件、执行命令、调用工具），
回复原路发回 QQ。

```
手机 QQ ──► QQ 开放平台网关(WebSocket) ──► qqbot 网关进程 ──► ACP stdio ──► dsh --profile acp
                    ▲                                                        │
                    └──────────────── QQ 消息回复 ◄──────────────────────────┘
```

| | |
|---|---|
| 适配 DSH | **0.1.7-rc.2（Web 端 / 桌面端）**；0.1.5-rc.2 仍可加载运行 |
| 包版本 | 0.4.4 |
| 许可证 | MIT |

## 特性

- **官方组合包**：以 bundle 形式发布，可直接用 Web GUI「插件 → 添加插件」导入，安装后状态与配置显示在「插件」页里，无需手改配置文件。
- **扫码即用**：在 QQ 开放平台扫码授权，AppID / AppSecret 自动写入；**扫码的那个 QQ 会自动加入私聊白名单**，不用再去查 openid。
- **一 QQ 会话 = 一 DSH 会话**：私聊与群聊各自独立，网关重启后用 `session/resume` 续接上下文。
- **可切换模型与思考强度**：`/model`、`/effort` 直接操作 ACP 会话的配置项；主界面里配的 provider 会自动同步给 QQ 这条链路。
- **收发文件**：QQ 发来的图片/语音/文件会落到本地并写进提示词；DSH 也能把本地文件作为 QQ 附件发回。
- **桌面端适配**：自动识别 Electron 运行时、自动拼出可用的 ACP 命令，无需手工填路径。
- **单实例保护**：同一 AppID 不会被两个网关同时连（避免被 QQ 判为发送过快）。

## 前置要求

1. 一个可用的 **DSH**：0.1.7-rc.2（Web 端或桌面端）或 0.1.5-rc.2。
2. 一个 **QQ 开放平台机器人**，能拿到 **AppID / AppSecret**
   （没有的话可以用插件的扫码绑定流程创建并授权）。
3. 桌面端或 Web 端至少要有一个能正常打开的 DSH 界面。
4. 用 GUI 安装时**不需要** Node / pnpm；只有「从源码构建」才需要 pnpm。

## 快速开始

1. **装插件**：侧栏「插件」→「添加插件」→ 填入
   `@lyw/dsh-qqbot`（发布包）或本地 tarball / 源码目录的**绝对路径** → 安装 → **立即启用**。
2. **重启 DSH**：安装接口会返回 `restart-required`，必须整进程重启（原因见下文）。
3. **填凭据**：重启后进「插件」→ `@lyw/dsh-qqbot`，点**「开始扫码绑定」**用手机 QQ 扫码；
   或手工填 AppID / AppSecret。
4. **确认白名单**：扫码绑定会把扫码的 QQ 自动加入 `allowUsers`；想更严格就点「只允许绑定的 QQ 使用」。
5. **开始对话**：在 QQ 里私聊机器人，或把它拉进群后 @ 它。

> 第一次连不上时，先看「插件」页卡片里的「查看网关日志尾部」——绝大多数问题（凭据、ACP、网络）都能在那里直接看出来。

## 安装

### 方式一：Web GUI（0.1.7-rc.2 起，推荐）

1. 侧栏打开 **「插件」** → 点 **「添加插件」**
2. 在输入框里填入下列**任意一种** spec，然后点「安装」：
   - 发布包名：`@lyw/dsh-qqbot`（已发布到 registry 时）
   - 本地 tarball：`<你的路径>\lyw-dsh-qqbot-<version>.tgz`
   - 本地源码目录：`<你的路径>\lyw-dsh-qqbot`
3. 安装完成后点 **「立即启用」**；随后**整进程重启 DSH**（见下面的「为什么必须重启」）

安装走的是官方组合包流程：本包 `package.json` 用
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明组合补丁，`cordis.patch.yml` 里的
`insert` 行就是插件的 loader 行 —— **不需要手工编辑 profile 的补丁文件**。

### 方式二：命令行（0.1.5 / 无 GUI 环境）

```powershell
dsh plugin --profile web add .\lyw-dsh-qqbot-<version>.tgz
```

0.1.5 这种把 tgz 当普通依赖装的路径**仍需手工补插件行**（那边没有组合包机制）：
在 `$DSH_HOME/profiles/web/cordis.patch.yml` 末尾插入

```yaml
- insert:
    - id: qqbot
      name: '@lyw/dsh-qqbot'
```

> 桌面版的 profile（`desktop`）由 Electron 应用独占管理，`dsh plugin --profile desktop` 会被拒绝
> （`profile "desktop" is managed exclusively by the Electron application`），桌面端请走方式一。

### 为什么必须重启

新装 / 替换包后 DSH 会报 `application: "restart-required"`：**必须整进程重启**，否则跑的还是旧版本。

- live profile 挂的 HMR 实例是 `{ root: [] }`（模块根为空），只做**配置**热重载，不会重新导入插件模块；
- 入口模块按包名经 Node ESM 解析，模块解析表与客户端模块图都在启动时建立一次，新装进来的包不在其中。

所以在运行中的宿主里直接点启用插件行，会看到 `qqbot (@lyw/dsh-qqbot): failed to import` ——
这是**预期行为**，不是插件坏了；重启后编辑器里的状态即变为 `active`。

### 从源码构建

```powershell
git clone https://github.com/Ellery1999/lyw-dsh-qqbot.git
cd lyw-dsh-qqbot
pnpm pack
```

产出的 `lyw-dsh-qqbot-<version>.tgz` 按方式一 / 方式二安装。

> 迭代提示：pnpm 对 `file:` tarball 按**路径+文件名**缓存，不按内容哈希。重打包同名 tgz 后安装
> 仍会解出旧内容 —— 每次改版本号换文件名，或清掉 `%LOCALAPPDATA%\pnpm\store\v11\file+<路径>+<包名>.tgz`。

## 在 QQ 里能用的命令

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
| `/sessions` | 列出可恢复的 DSH 会话（最近 20 条，带网关自己记的备注） |
| `/switch <编号或 id 前缀>` | 把当前 QQ 会话切换到指定的 DSH 会话（`session/resume`） |
| `/cd <绝对路径>` | 换工作目录，下一条消息在新目录里新建会话 |
| `/whoami` | 当前会话标识（openid / group_openid） |
| `/send <绝对路径>` | 把一个本地文件作为 QQ 附件发给你 |

同一 QQ 会话串行执行；处理中的消息会先回一条「已排队」，超过 20 秒未产出文本会回一条进度提示。

> **被动回复额度**（QQ 平台限制，单聊与群聊不同）：**单聊 60 分钟 / 4 条**、**群聊 5 分钟 / 5 条**
> （重复 `msg_id + msg_seq` 会报 40054005）。超长回复按 1200 字分段，超预算的全文写入
> `$DSH_HOME/qqbot/reply-*.md`。附件也占额度，所以一条回复里附件优先占位：文本至少留 1 段。

## 配置

两种入口等价，都写进同一个设置命名空间 `qqbot`：

- **「插件」页卡片**（0.1.7-rc.2 起，推荐）：侧栏「插件」→ `@lyw/dsh-qqbot` → 详情页里看状态、
  改配置、扫码绑定、重启网关、收紧白名单。
- **独立配置页**：`http://127.0.0.1:<webServer 端口>/plugins/qqbot`（桌面端为 19387；0.1.5 的 web
  profile 通常是 3080），可看连接状态与日志尾、一键重启、手动填写。

> 0.1.5 的「设置 → 插件 → 配置 → qqbot」表单在 0.1.7-rc.2 已**不存在**：拥有它的
> `settings.plugin.item` 槽位连同 configurable 标签页被整体删除，插件配置改由组合包自己在
> 「插件」页声明。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `appId` | — | QQ 开放平台机器人 AppID |
| `appSecret` | — | AppSecret（`role('secret')`，接口里从不回显） |
| `sandbox` | `false` | 走沙箱域名 `sandbox.api.sgroup.qq.com` / `sandbox.q.qq.com` |
| `workspace` | `$DSH_HOME/qqbot/workspace` | DSH 会话的工作目录 |
| `acpCommand` | 自动探测 | 启动 ACP agent 的命令行；桌面端会自动填好 |
| `autoApprove` | `true` | 自动允许 ACP 权限请求 |
| `allowUsers` / `allowGroups` | `[]` | openid 白名单，留空不限制 |
| `extraPrompt` | — | 追加到每条消息后的要求 |

状态与日志落在 `$DSH_HOME/qqbot/`：`status.json`（连接/会话/统计/最近私聊 openid）、
`plugin.json`（插件挂载现场）、`gateway.log`、`sessions.json`（会话映射）、`attachments/`。

### 白名单怎么填

私聊要填 **user_openid**，群聊要填 **group_openid**，两者是不同的值。

**推荐：扫码绑定会自动填。** 扫码成功后插件会把扫码人自己的 `user_openid` **自动追加**进
`allowUsers`（已存在则不重复，不覆盖你手填的其他值）——腾讯的扫码结果里就带这个字段，
所以不需要再去别处查 id。日志会写明：

```
qqbot: 扫码绑定完成，已写入设置（appId=…；已把扫码的 QQ 加入私聊白名单：5D6F3…）
```

想手工加别人、或没有扫码记录时，还有三种拿法：

1. **卡片/配置页的「只允许绑定的 QQ 使用」**：白名单为空时该按钮会出现，点击即把白名单设为
   对应 openid。优先用扫码绑定记录；没有绑定记录时回退到「最近私聊发送者 openid」——
   所以先给机器人随便发一条消息（例如 `/help`），按钮就能用了。
2. **在 QQ 里发 `/whoami`**：机器人回复 `会话标识：c2c:<user_openid>`（群里是 `group:<group_openid>`），
   去掉前缀填进白名单。
3. **看 `gateway.log`**：每条入站消息都会记 `key=c2c:<user_openid>` 或 `key=group:<group_openid>`。

## 「插件」页里的卡片

0.1.7-rc.2 的插件配置入口由官方插件页 `dsh-client-ui-plugin-manager` 提供，它声明了三个槽位：

| 槽位 | 类型 | key | 渲染位置 |
|---|---|---|---|
| `plugins.item` | list | 注册方自己的 `id` | 「官方」分组里官方插件的配置页 |
| `plugins.bundle.config` | **keyed** | **组合包 npm 包名** | 组合包详情页（描述与插件行之间） |
| `plugins.row.config` | keyed | `<包名>#<行 id>` | 某一行的详情页 |

本插件是组合包，因此 `lib/client.js` 注册到 `plugins.bundle.config`，key 为 `@lyw/dsh-qqbot`：

```js
ctx.slots.inject('plugins.bundle.config', () =>
  ctx.slots.register({ name: 'plugins.bundle.config', key: '@lyw/dsh-qqbot' }, QqbotCard),
)
```

改这一块前请先读下面几条（都是踩过的坑）：

- **该槽位不会收到 `form` prop**。官方只给 `plugins.item` / `plugins.row.config` 传
  `form.state` / `form.mutate`（官方理由：*"Bundle-wide pages can contain several entries and have
  no single form."*）。所以卡片自带数据流：读写全部走 `/plugins/qqbot/api/*`，不经过 Typert Remote。
- **浏览器半是经典脚本**（不是 ESM）：`window.__ModuleLoader__.load({ id, factory })`，
  `id` 必须**正好是包名**（loader 行只按裸包名挂浏览器半），且只能 `require('react')`。
- **写坏浏览器半会让整个 Web GUI 起不来**（`web boot: N entries did not activate`，不是只坏你的面板）。
- **桌面端不能**用 `<a target="_blank" href="/plugins/qqbot">` 打开独立页面：Electron 外壳的
  `setWindowOpenHandler` 要么直接 deny、要么只把 `https:` 交给 `shell.openExternal`，本地
  `http://127.0.0.1` 链接会被静默丢弃（表现为「点了没反应」）。因此配置与扫码都做在卡片里，
  独立页面只用「复制配置页地址」按钮给出。

## 桌面端适配

桌面版（Electron）与 Web 端有两处本质差异，插件都已处理：

**1. ACP 命令自动探测。** 桌面版把整个 DSH 运行时放进 `app.asar`，PATH 上没有 `dsh`，且
`process.execPath` 就是 `DeepSeek Harness.exe`。`defaultAcpCommand()` 因此在检测到 Electron 运行时
且 asar 内 CLI 存在时，自动拼出：

```
"<app>\DeepSeek Harness.exe" "<app>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile acp
```

配套两点（否则这条命令会失败）：

- **`ELECTRON_RUN_AS_NODE=1`**：Electron 不带这个变量就是 GUI 而不是 node，spawn 会起出第二个窗口。
  网关照此设置子进程环境，`startAcp()` 再显式补一次（命令里出现 `app.asar` 时）。
- **不过 `cmd.exe`**：命令路径含空格，Windows 上 `spawn(..., { shell: true })` 会被 cmd.exe 在空格处
  切断（表现为 `'D:\DSH' 不是内部或外部命令` → `ACP agent exited before answering`）。现在的规则：
  命令本身是**已存在的 `.exe`** 时 `shell: false` 直接 exec；只有 `dsh.cmd` / `dsh.ps1` 这类启动器才走 cmd.exe。

**2. provider / 模型配置自动复用。** QQ 里 `/model` 能看到的 provider 完全取决于 ACP 用的 profile
（`dsh --profile acp`）自己的组合；用户在主 profile 里配的 provider，ACP 默认看不到。
`syncAcpProviderConfig()` 因此把手**当前 profile**（读 `DSH_PROFILE_DIR`，因此 **desktop 与 web 都适用**）
里模型相关的条目自动复制到 acp profile：

- 复制条目：`llm-pi-ai`（providers）/ `agent-default-model` / `permission`
- 复制时机：插件挂载时 + 每次真正拉起网关前 ⇒ 在主界面换模型后，QQ 侧下次启动自动跟上
- **不解析 YAML**：按顶层 `- id:` 分块搬运，避免引入运行时依赖
- **密钥不用搬**：`apiKeyEnv` 是凭据引用（`z.string().role('credential-ref')`），运行期由
  `ctx.credentials` 从 `$DSH_HOME/.credentials.yaml` 解析，两个 profile 共用同一个 key

两个刻意的取舍：

| 取舍 | 原因 |
|---|---|
| 只同步 acp profile，不用 `$DSH_HOME/cordis.patch.yml` | home 级 patch 会叠加在**所有** profile 之后（含 desktop），会遮蔽用户在设置里的后续修改 |
| acp profile 未初始化时不写 | 只 mkdir 一个含 `cordis.patch.yml` 的目录会做出启动不了的半成品 profile；等启动器初始化后再同步 |

> ⚠️ `$DSH_HOME/profiles/acp/cordis.patch.yml` 是**自动生成物**（头部有 `# 由 @lyw/dsh-qqbot 自动同步`），
> 手改会在下次同步被覆盖 —— 要改模型请改主 profile 的设置。

## 收发文件

**QQ → DSH（入站）**：附件用 `Authorization: QQBot <token>` 立刻下载到 `attachments/`，再把本地路径
写进提示词（QQ 的 CDN URL 有时效，必须收到即取）。文件名优先用 QQ 给的 `filename`，它常常为空，
此时按 `content_type` 补扩展名（`image/png` → `.png`）。图片会要求先用 `read_image` 看图再回答；
语音取 `voice_wav_url` 转好的 WAV 落盘（原始 silk DSH 读不了），并把 QQ 自带的 `asr_refer_text`
转写一并写进提示词。引用消息（`message_type=103`）里嵌套的附件也会取出来。

**DSH → QQ（出站）**：两个口子，同一条流水线——

1. **DSH 自己发**：提示词里已交代约定 —— 要发文件时在回复里**单独一行**写 `[[send:绝对路径]]`
   （一行一个，最多 3 个）。这一行不会出现在你看到的消息里，网关摘出来上传后作为 QQ 附件发出。
2. **你点名要**：`/send <绝对路径>`，不经过模型。

不给 agent 加工具的原因：ACP 侧拿不到「这个会话对应哪个 QQ 会话」，工具无法自证收件人；
而回复文本天然带这个上下文。

上传走**分片**（`upload_prepare` → 逐片 PUT 预签名地址 → `upload_part_finish` → 带 `upload_id`
调 `/files` 合并拿 `file_info` → `msg_type=7`）。不用 URL 直传，因为那条路要求文件已在公网可访问，
而 DSH 手上的文件都在本机。`file_type` 按扩展名定：`.png/.jpg/.jpeg/.gif/.webp/.bmp` → 1（图片，
直接展示）、`.mp4` → 2、`.silk` → 3，其余一律 4（文件卡片，可下载）。

## 故障排查

| 症状 | 原因 | 处理 |
|---|---|---|
| 启用后报 `qqbot (@lyw/dsh-qqbot): failed to import` | 新装的模块还没进宿主进程的解析表 | **整进程重启 DSH**（预期行为，不是坏了） |
| 插件页里看不到卡片 | 浏览器半未加载 / key 不匹配 | 确认包名与注册 key 都是 `@lyw/dsh-qqbot`，重启后 Ctrl+F5 硬刷新 |
| 点了「打开配置扫码页」没反应 | 桌面端 Electron 外壳丢弃本地 `http://127.0.0.1` 外链 | 已改为卡片内配置/扫码；需要链接时用「复制配置页地址」 |
| 扫码成功但一直连不上 | 多半是 ACP 子进程起不来 | 看卡片「查看网关日志尾部」；若见 `'D:\DSH' 不是内部或外部命令`，说明 `acpCommand` 路径含空格且没过 `shell:false`（0.4.3+ 已修） |
| QQ 里只看到官方 provider，看不到自己配的 | ACP 用的 `acp` profile 里没有该 provider | 0.4.4+ 会自动同步；仍不行则确认主 profile 的 `llm-pi-ai` 配对了，并重启网关 |
| `/model` 切换无效 | 模型选项来自 ACP `configOptions`，未就绪时为空 | 先 `/status` 看模型字段；必要时重启网关 |
| 机器人不回消息 / 回「发送过快」 | 触发被动回复额度或出现双连接 | 遵守单聊 60 分钟 4 条、群聊 5 分钟 5 条；确认只有一个网关（`gateway.lock` 会拦住第二个） |
| 发文件报「超过今天发送文件容量上限」 | 平台按 bot 计的每日容量上限（`40093002`） | 次日恢复，网关已翻译成人话，不会重试 |
| 白名单为空 | 任何人都能驱动 DSH | 扫码会自动加白名单，或点「只允许绑定的 QQ 使用」 |

## 版本兼容

| DSH | 状态 |
|---|---|
| **0.1.7-rc.2（Web / 桌面端）** | ✅ 已适配：组合包安装、「插件」页卡片、Electron ACP 启动、provider 自动复用 |
| 0.1.5-rc.2 | 仍可加载运行：`.volatile()` / `installSection` 等差异用能力探测兜住；但设置写入路径不可用（旧 `installSection` 已删），配置改由 profile 补丁固定 |

## 安全提醒

- 白名单（`allowUsers` / `allowGroups`）为空时，**任何**能给机器人发消息的 QQ 用户都能驱动 DSH；
  而 ACP 会话沿用 DSH 的权限预设（若为 `danger-full-access`，等于把文件与命令执行权交给对方）。
  **扫码绑定会自动把扫码人加入 `allowUsers`**，也可以用「只允许绑定的 QQ 使用」手工收紧。
  没有扫码绑定记录时，该按钮会用「最近私聊发送者」的 openid——确认提示里会写明是哪个 openid。
- 独立配置页与 `/plugins/qqbot/api/*` 只监听 loopback，但未额外鉴权：本机其他程序可读取 AppID 与状态，
  读不到 AppSecret（接口从不回显）。
- AppSecret 以明文存于 profile 的 `cordis.patch.yml`（0.1.7 的写入路径）或 `$DSH_HOME/settings.yaml`（0.1.5），
  仅本机可读。

## 已知限制

- 未实现：频道（guild）收发、审批按钮卡片、多机器人实例。均不影响私聊/群聊对话与收发文件。
- 桌面端无法从卡片跳系统浏览器打开本地配置页（Electron 外壳策略），这是刻意改成「配置与扫码都在卡片里」的原因。
- `session-title-llm`（模型总结标题）在 ACP 场景下不工作：请求与路由都正常，但标题从不落盘，
  且 `session-title` 服务在 `work.signal.aborted` 时静默 `return`。本插件不依赖它 ——
  `composePrompt` 把用户正文放在提示词最前面（标题退化时至少是用户自己说的话），
  `/sessions` 的备注则由网关自己按 `sessionId` 记在 `sessions.json`。
- acp profile 的 provider 配置是**同步产物**，手工修改会被覆盖；要改模型请改主 profile 设置。
- `session/request_permission` 的应答使用 ACP v1 现行格式（`{outcome:{outcome:'selected',optionId}}`），
  不要回退成旧版 `{option, outcome:"allow_once"}`，`@agentclientprotocol/sdk 1.4.0` 会校验失败。

## 项目结构

```
lib/
  index.js           Host 半：设置命名空间、网关生命周期、HTTP 接口、provider 同步
  client.js          浏览器半：注册进「插件」页的 plugins.bundle.config
  gateway.mjs        常驻网关：QQ 事件 → 会话路由 → ACP → 回复
  qq-transport.mjs   QQ Bot API v2 传输层（token / WebSocket / 发送）
  acp-client.mjs     ACP v1 stdio 客户端
  bind.mjs           扫码绑定（lite 接口 + AES-256-GCM 解密）
  page.mjs           独立配置页 HTML
cordis.patch.yml     组合包补丁（声明插件 loader 行）
tests/               单测 / 客户端契约 / 离线 e2e
```

## 开发

```powershell
npm run test:unit      # 纯逻辑：分片、纯文本清洗、命令行切分、AES-GCM 解密、二维码 SVG
npm run test:client    # 客户端 bundle 契约：__ModuleLoader__ 注册、槽位 key、react 渲染
npm run test:offline   # 用本地模拟 QQ 平台跑 握手/命令/去重/白名单，不消耗模型额度
npm test               # 完整：再加 真实对话 + 会话持久化 + 群聊 @（会调用模型）
```

`tests/mock-qq.mjs` 起一个本地 HTTP + WebSocket 服务，实现 token / `/gateway` / `/v2/*/messages` /
op10-hello / op2-identify→READY / op1→op11，于是整条「QQ 事件 → 会话路由 → ACP → 回复发回 QQ」
都能在离线环境断言。

测试用端点覆盖（也便于指向自建代理）：

| 环境变量 | 作用 |
|---|---|
| `DSH_QQBOT_TOKEN_URL` | 覆盖 `https://bots.qq.com/app/getAppAccessToken` |
| `DSH_QQBOT_API_BASE` | 覆盖 `https://api.sgroup.qq.com` |
| `DSH_QQBOT_EXIT_ON_STDIN_END` | `1` 时把 stdin EOF 当退出信号（插件拉起时设置） |

## 贡献

欢迎 issue / PR。改动前请先跑 `npm run test:unit` 与 `npm run test:offline`（不需要模型额度）；
涉及浏览器半的改动请一并跑 `npm run test:client`。

## License

[MIT](LICENSE) © 2026 lyw
