# dsh-win-notify

> DSH（DeepSeek Harness）**宿主层** Windows 原生 Toast 通知插件。
> 标签页关掉、浏览器整个关掉，通知照响。

[English](README.en.md) | 中文

---

## 为什么需要它

通知插件可以挂在两个地方，差别很大。

挂在**渲染层**（浏览器半身）的方案，通知逻辑跑在页面里的 JS 上。你把标签页切走、关掉窗口、或者干脆关掉浏览器，它就安静了——恰好是你最需要被叫回来的时候。

本插件挂在**宿主层**（Cordis host 半身），也就是 DSH 主进程里。事件在进程内直接产生，不经过浏览器，因此**前台窗口开不开、标签页在不在，都不影响通知送达**。

| | 宿主层（本插件） | 渲染层 |
|---|---|---|
| 标签页切走 | ✅ 照响 | ⚠️ 取决于实现 |
| 浏览器窗口关闭 | ✅ 照响 | ❌ 失效 |
| 合并 / 去重的落点 | 单个宿主进程，天然单点 | 各页面各自为政，跨页面无法协调 |
| 前台窗口探测 | ✅ 系统级（Win32） | ❌ 只能看页面自身焦点 |

## 功能

下表逐条对应 `index.mjs` 中实际注册的监听（行号以 `index.mjs` 为准，供核对）。

| 触发事件 | 通知内容 | 音效 | 实现位置 |
|---|---|---|---|
| **对话回合完成** | `✅ DSH 对话完成` + 会话标题 + 耗时 | `Notification.IM` | `session/event` → `turn/end` |
| **对话出错 / 中断** | `❌ DSH 出错` / `⚠️ DSH 对话中断` + 原因 | `Notification.Reminder` | 同上，按 `reason.kind` 分支 |
| **子代理完成** | `✅ 子任务完成` / `⚠️ 子任务结束` + 摘要 | 完成 `Notification.IM`；异常结束 `Notification.Reminder` | `ctx.on("subagent/end")` |
| **后台任务（job）完成** | `✅ DSH 任务完成` / `❌ DSH 任务失败` / `⚠️ DSH 任务已取消` | 完成 `Notification.IM`；失败 / 取消 `Notification.Reminder` | `ctx.jobs.events.subscribe({owners:"all"})`，取 `type === "settled"` |
| **模型提问等你回答** | `🤔 DSH 在等你回答` + 问题摘要 + 选项预览 | `Notification.SMS` | `ctx.on("user-questions/request")` |
| **工具审批等你决定** | `🔐 DSH 等待你审批` + 工具名 + 理由 | `Notification.Default` | `ctx.on("approval/request")` |

**顺带覆盖**：计划评审（plan-review）走的是 `user-questions/request` 且带 `intent: "plan-review"`，因此**已被提问通知这条路径覆盖**，无需单独配置。

### 通知行为

| 行为 | 说明 |
|---|---|
| **前台探测** | `mode: auto`（默认）下先用 Win32 `GetForegroundWindow` 探测前台窗口；**你正在看 DSH 就不弹**，切走 / 最小化 / 关页面才弹。想看全部通知可设 `always`。 |
| **正文标注** | 通知正文以「`【工作区】会话 · 内容`」的形式标注归属，多工作区并行时能分辨是哪一路跑完了。 |
| **合并** | 同一工作区短窗口内的多会话完成会合并为一条（`✅ DSH 完成 ×N`）；后台 job 与随后的回合完成也会合并。 |
| **速率配额** | 全局限制通知频率，避免多会话同时完成时刷屏（`minIntervalMs` / `ratePerMinute`）。 |
| **免打扰时段** | 支持跨午夜时间窗（如 `23:00-07:30`）；提问与审批默认作为紧急事件**穿透**（`quietUrgent`）。 |
| **点击通知** | Desktop 下抬回 DSH 窗口（`dsh://open`）；其他场景打开带鉴权 token 的 DSH 页面。**不跳转到具体会话**（见「不做」）。 |

### 音效

音效使用 Windows 系统具名音（`Notification.*`），按事件区分：完成类 `Notification.IM`、提问 `Notification.SMS`、审批 `Notification.Default`、出错/中断 `Notification.Reminder`。

> ℹ️ **音效按事件固定，不可自定义。** `sound` 只是开关（`true`/`false`），改不了音色；要换音色需改 `index.mjs` 里的 `SOUND` 表。
>
> ⚠️ 改 `SOUND` 表时须写 `Notification.IM` 这种形式，**不要写 `ms-winsoundevent:Notification.IM`**——后者会被底层通知库判为非 `Notification.` 前缀而**静默改写为默认音**（不报错，只是音效不对）。这也是本插件不提供自定义音频的原因，见「不做」。

## 安装

包名：`@zhang-tod/dsh-win-notify` · 仓库：[zhang-tod/dsh-win-notify](https://github.com/zhang-tod/dsh-win-notify)

装完**必须重启 DSH** 才会加载（宿主层插件在启动时挂载）。

> **重启由你自己操作。** 请通过 DSH 的正常退出 / 启动入口重启，不要在 DSH 运行中直接终止进程——本插件的安装过程不会、也不应该替你重启 DSH。

### DSH Desktop

Desktop 配置档由 Electron 应用独占管理，CLI 的 `dsh plugin` 不接受它（见下方「已知限制」）。请走应用内入口：

1. 侧栏 → **插件**（Plugins）
2. **Add plugin**，填 `@zhang-tod/dsh-win-notify`
3. 安装完成后**启用**该 bundle
4. 由你自行重启 DSH

### CLI 管理的配置档

适用于 `web`、`headless`、`sdk`、`acp` 及自建配置档：

```sh
dsh plugin --profile <profile> add @zhang-tod/dsh-win-notify
```

随后重启该配置档。

### 卸载

Desktop：侧栏 → **插件** → 找到该 bundle → 卸载 → 由你自行重启 DSH。

CLI 配置档：

```sh
dsh plugin --profile <profile> remove @zhang-tod/dsh-win-notify
```

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto` = 正在看 DSH 时不弹；`always` = 总弹；`never` = 不弹 |
| `turns` | `true` | 对话回合完成通知 |
| `subagents` | `true` | 子代理完成通知 |
| `jobs` | `true` | 后台任务（job）完成通知 |
| `questions` | `true` | 模型提问等你回答时的通知 |
| `approvals` | `true` | 工具审批等你决定时的通知 |
| `sound` | `true` | 是否播放提示音（具名音效见「音效」一节） |
| `port` | `0` | `0` = 自动取 DSH 的实际端口（推荐）。**不要写死端口**：DSH 的端口由系统分配，写死会让「点击通知」开到错误的页 |
| `desktopRaise` | `true` | Desktop 下点击通知抬窗（`dsh://open`）而非开浏览器 |
| `quietHours` | `""` | 免打扰时段，如 `"23:00-07:30"`（支持跨午夜），多段用逗号分隔（`"09:00-12:00,14:00-18:00"`）；空 = 关闭 |
| `quietUrgent` | `true` | 免打扰时段内仍放行紧急事件（提问 / 审批） |
| `minIntervalMs` | `3000` | 全局速率配额：相邻两条通知的最小间隔（`0` = 不限） |
| `ratePerMinute` | `20` | 全局速率配额：每分钟最多发几条（`0` = 不限） |
| `mergeWindowMs` | `3000` | 同工作区多会话完成 / job+回合 的合并窗口 |
| `questionPreviewChars` | `120` | 提问正文预览长度 |
| `questionOptions` | `3` | 选项预览个数（`0` = 不显示选项） |
| `summaryMaxChars` | `120` | 通知正文摘要的最大字符数 |
| `probeTimeoutMs` | `5000` | 前台窗口探测的超时（毫秒） |
| `icon` | `""` | 通知插图（png/jpg/gif 绝对路径）；空 = 内置 DSH 鲸鱼图 |

以上 19 项与 `index.mjs` 的 `DEFAULTS` 一致。覆盖方式：在配置档的 `cordis.patch.yml` 里按 `id: dsh-win-notify` 写 `config`。

## ⚠️ 不做

以下为**有意的能力边界**，不是待办事项。列在这里是为了避免预期落差。

| 不做 | 原因 |
|---|---|
| **跨平台** | 仅支持 Windows。通知、前台探测、点击跳转全部依赖 Win32 与 Windows Toast API，没有 macOS / Linux 实现，也不在计划内。 |
| 自定义音频文件（wav / mp3） | Windows Toast 音效只能用**系统具名音**（本插件用 `Notification.*` 形式）。未打包（unpackaged）应用拿不到 `ms-appx:///` 资源，而 `C:/` 之类的文件路径在 Toast 里是 **Unsupported**。所用通知库还会把任何非 `Notification.` 前缀的音效**静默改写为默认音**。 |
| **toast 按钮一键审批** | 需要注册 COM 服务器并保持常驻进程；且审批决策走 Cordis **waterfall 返回值**，进程外回调无法注入结果。本插件只负责**提醒**，审批仍须回 DSH 界面完成。 |
| **常驻通知**（`scenario="reminder"`） | 系统规定：该场景下若没有能**在后台激活**的 toast 按钮，通知会被**静默忽略**。上一条不做，这一条就没有成立条件。 |
| **点击通知跳转到具体会话** | 宿主层拿不到客户端半身的 `ctx.uiWorkspace` 服务，无法在宿主侧构造指向某个会话的深链接。点击只会打开 DSH 主界面。 |
| **声明 `@deepseek-ai/dsh-*` peerDependencies** | 有意为之。DSH 会拿声明的 peer 范围做兼容性门禁，声明即可能被拦。本插件只依赖稳定的公开宿主 API，故不声明。 |
| **图形设置页** | 第一版不做，配置直接写 `cordis.patch.yml`。 |

## 已知限制

实测得到，如实列出。

| 限制 | 说明 |
|---|---|
| 通知归属可能显示为通用值 | 插件使用 Windows Toast 的应用标识去署名通知，默认值取 DSH Desktop 在系统注册的应用标识 `com.deepseek.dsh`。若你所用身份未在系统注册（例如某些 CLI 配置档），通知在系统通知中心里的**来源名称与图标可能显示为通用值**——这不影响通知内容与点击行为。 |
| 前台探测可能失效 | 探测依赖**窗口标题 / 进程名的文本匹配**。窗口标题被改写（浏览器扩展、自定义标题、远程/虚拟桌面等）时匹配不上，会出现「正看着 DSH 却仍然弹通知」。 |
| 全权限下收不到审批通知 | DSH 处于全权限（`approval: never`）时，系统层面**根本不会发出审批请求**，因此本插件不会（也无法）为该事件弹通知。这是预期行为，不是缺陷。 |
| Desktop 配置档不能用 CLI 装 | `dsh plugin --profile desktop` 被 DSH 直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。这是 DSH 的既有机制，非本插件缺陷；请走应用内「插件」页。 |

## 常见问题

**装完没反应？**
宿主层插件在启动时挂载，装完必须**重启 DSH**。

**标签页关了还会响吗？**
会。插件在 DSH 主进程里跑，与浏览器页面无关。

**支持 macOS / Linux 吗？**
不支持，仅 Windows。见「不做」。

**怎么彻底静音？**
把 `mode` 设为 `never` 可关闭全部通知；只想关掉声音、保留弹窗，则把音效开关（`sound`）设为 `false`。具体配置项见「配置」章节。

**为什么我点了通知没跳到刚才那个会话？**
这是有意为之。点击通知会打开 **DSH 主界面**，不会定位到某个具体会话——宿主层拿不到客户端半身的会话导航服务。会话级跳转见「不做」。

**用 CLI / 浏览器方式访问 DSH 时，点通知能打开吗？**
能。DSH 的界面地址需要鉴权 token，本插件会在打开时自动带上，因此打开后是**可直接使用**的界面，而不是 401 错误页。（Desktop 用户点通知则是把 DSH 窗口抬到前台。）

**审批时怎么没弹通知？**
先确认 DSH 不是全权限模式（`approval: never`）。该模式下系统层面根本不发出审批请求，插件自然收不到——不是插件没实现。切到需要审批的权限档（如 `ask`）即可验证。

## 实现说明

| 项 | 说明 |
|---|---|
| 运行位置 | DSH 宿主进程（Cordis host 半身），非渲染层 |
| 通知通道 | [`node-notifier`](https://www.npmjs.com/package/node-notifier) 发 Windows Toast；不可用时降级为 PowerShell WinRT toast（降级路径无点击跳转） |
| 前台探测 | 调用 Win32 `GetForegroundWindow` / `GetWindowText` / `GetWindowThreadProcessId`，带短时结果缓存 |
| 事件来源 | DSH 公开宿主 API（`session/event`、`subagent/end`、jobs 服务、提问服务等），不使用私有内部接口 |

## 许可

[MIT](LICENSE) © 2026 Zhang Zhaodong
