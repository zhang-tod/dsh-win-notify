# dsh-win-notify

> **Host-side** Windows native toast notifications for DSH (DeepSeek Harness).
> Close the tab — close the whole browser — the toast still fires.

English | [中文](README.md)

---

## Why this exists

A notification plugin can sit in one of two places, and the difference matters.

A **renderer-side** plugin keeps its notification logic in JavaScript running in the page. Switch away from the tab, close the window, or quit the browser, and it goes quiet — exactly when you most needed to be called back.

This plugin is **host-side**. It runs inside the DSH main process, beside the Cordis host half, so events reach it directly without crossing the browser boundary. Whether a DSH window is open, minimized, or absent makes no difference to delivery.

| | Host-side (this plugin) | Renderer-side |
|---|---|---|
| Tab switched away | ✅ Still fires | ⚠️ Implementation-dependent |
| Browser window closed | ✅ Still fires | ❌ Silent |
| Where merging / dedupe happens | One host process — a natural single point | Each page on its own; no cross-page coordination |
| Foreground detection | ✅ System-level (Win32) | ❌ Page focus only |

## Features

Each row below corresponds to a listener actually registered in `index.mjs`. Notification titles are shown as the literal strings the code emits; the English gloss in brackets is a reading aid, not a translated string.

| Event | Notification | Sound | Implementation |
|---|---|---|---|
| **Conversation turn completes** | `✅ DSH 对话完成` (“DSH turn complete”) + session title + duration | `Notification.IM` | `session/event` → `turn/end` |
| **Conversation errors / is interrupted** | `❌ DSH 出错` (“DSH error”) / `⚠️ DSH 对话中断` (“DSH conversation interrupted”) + reason | `Notification.Reminder` | same, branched on `reason.kind` |
| **Subagent completes** | `✅ 子任务完成` (“subtask complete”) / `⚠️ 子任务结束` (“subtask ended”) + summary | `Notification.IM` on success; `Notification.Reminder` when it ends abnormally | `ctx.on("subagent/end")` |
| **Background job completes** | `✅ DSH 任务完成` / `❌ DSH 任务失败` / `⚠️ DSH 任务已取消` (“job complete” / “job failed” / “job cancelled”) | `Notification.IM` on success; `Notification.Reminder` on failure / cancellation | `ctx.jobs.events.subscribe({owners:"all"})`, on `type === "settled"` |
| **Model is waiting for your answer** | `🤔 DSH 在等你回答` (“DSH is waiting for your answer”) + question summary + option preview | `Notification.SMS` | `ctx.on("user-questions/request")` |
| **Tool approval is waiting** | `🔐 DSH 等待你审批` (“DSH is waiting for your approval”) + tool name + reason | `Notification.Default` | `ctx.on("approval/request")` |

**Also covered**: plan review arrives as a `user-questions/request` carrying `intent: "plan-review"`, so the question-notification path already covers it — no separate configuration needed.

### Notification behaviour

| Behaviour | Detail |
|---|---|
| **Foreground detection** | Under `mode: auto` (the default) the plugin first probes the foreground window with Win32 `GetForegroundWindow`: **no toast while you are looking at DSH**. It fires once you switch away, minimize, or close the page. Set `always` to receive everything. |
| **Body annotation** | The body annotates ownership as `【workspace】session · content`, so with several workspaces running in parallel you can tell which one finished. |
| **Merging** | Several sessions finishing in one workspace within a short window collapse into a single toast (`✅ DSH 完成 ×N`); a background job and the turn that follows it merge too. |
| **Rate quota** | A global cap on notification frequency keeps a burst of parallel sessions from flooding you (`minIntervalMs` / `ratePerMinute`). |
| **Quiet hours** | Windows may cross midnight (e.g. `23:00-07:30`); questions and approvals pass through as urgent events by default (`quietUrgent`). |
| **Clicking a toast** | On Desktop it raises the DSH window (`dsh://open`); elsewhere it opens the DSH page with its auth token attached. **It does not navigate to a specific session** (see *Non-goals*). |

### Sounds

Sounds are Windows system named sounds (`Notification.*`), picked per event: completion uses `Notification.IM`, questions `Notification.SMS`, approvals `Notification.Default`, and errors/interruptions `Notification.Reminder`.

> ℹ️ **Sounds are fixed per event and cannot be customised.** `sound` is a plain on/off switch; changing the tone itself means editing the `SOUND` table in `index.mjs`. The values there use the `Notification.IM` form — they must **not** be written as `ms-winsoundevent:Notification.IM`, which the underlying notification library judges to lack the `Notification.` prefix and **silently rewrites to the default sound** (no error is raised; only the tone is wrong). This is also why the plugin offers no custom audio (see *Non-goals*).

## Installation

Package: `@zhang-tod/dsh-win-notify` · Repo: [zhang-tod/dsh-win-notify](https://github.com/zhang-tod/dsh-win-notify)

DSH must be **restarted** after installation — host-side plugins mount at startup.

> **Restarting is yours to do.** Use DSH's own quit/launch entry point rather than killing the process while DSH is running. Neither the plugin nor its install path will restart DSH for you.

### DSH Desktop

The Desktop profile is owned exclusively by the Electron application and the `dsh plugin` CLI refuses it (see *Known limitations*). Use the in-app surface instead:

1. Sidebar → **Plugins**
2. **Add plugin**, enter `@zhang-tod/dsh-win-notify`
3. **Enable** the bundle once installation finishes
4. Restart DSH yourself

### CLI-managed profiles

For `web`, `headless`, `sdk`, `acp`, or your own profiles:

```sh
dsh plugin --profile <profile> add @zhang-tod/dsh-win-notify
```

Then restart that profile.

### Uninstalling

Desktop: Sidebar → **Plugins** → open the bundle → uninstall → restart DSH yourself.

CLI-managed profiles:

```sh
dsh plugin --profile <profile> remove @zhang-tod/dsh-win-notify
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `mode` | `auto` | `auto` = no toast while you are looking at DSH; `always` = always toast; `never` = never |
| `turns` | `true` | Notify when a conversation turn completes |
| `subagents` | `true` | Notify when a subagent completes |
| `jobs` | `true` | Notify when a background job completes |
| `questions` | `true` | Notify when the model is waiting for your answer |
| `approvals` | `true` | Notify when a tool approval is waiting for your decision |
| `sound` | `true` | Whether to play the notification sound (named sounds — see *Sounds*) |
| `port` | `0` | `0` = resolve DSH's actual port automatically (recommended). **Do not hard-code a port**: DSH's port is assigned by the system, so a fixed value sends a toast click to the wrong page |
| `desktopRaise` | `true` | On Desktop, clicking a toast raises the DSH window (`dsh://open`) instead of opening a browser |
| `quietHours` | `""` | Quiet-hours window, e.g. `"23:00-07:30"` (crossing midnight is supported); separate multiple windows with commas (`"09:00-12:00,14:00-18:00"`); empty = off |
| `quietUrgent` | `true` | Urgent events (questions / approvals) still get through during quiet hours |
| `minIntervalMs` | `3000` | Global rate quota: minimum gap between two consecutive notifications (`0` = unlimited) |
| `ratePerMinute` | `20` | Global rate quota: maximum notifications per minute (`0` = unlimited) |
| `mergeWindowMs` | `3000` | Merge window for several sessions in one workspace, or a job plus its turn |
| `questionPreviewChars` | `120` | Preview length for the question body |
| `questionOptions` | `3` | Number of options previewed (`0` = hide options) |
| `summaryMaxChars` | `120` | Maximum characters in the notification body summary |
| `probeTimeoutMs` | `5000` | Foreground-window probe timeout, in milliseconds |
| `icon` | `""` | Toast image (absolute path to a png/jpg/gif); empty = the built-in DSH whale |

All 19 rows match the `DEFAULTS` block in `index.mjs`. To override them, write `config` under `id: dsh-win-notify` in your profile's `cordis.patch.yml`.

## ⚠️ Non-goals

These are deliberate boundaries, not a backlog. They are listed so nobody has to guess.

| Not doing | Why |
|---|---|
| **Cross-platform support** | Windows only. Notifications, foreground detection, and click handling all depend on Win32 and the Windows Toast APIs. There is no macOS or Linux implementation, and none is planned. |
| Custom audio files (wav / mp3) | Windows toast sounds can only be **system named sounds** (this plugin uses the `Notification.*` forms). An unpackaged app cannot reference `ms-appx:///` resources, and a file path such as `C:/...` is **Unsupported** in a toast. The underlying notification library also **silently rewrites** any sound lacking the `Notification.` prefix to the default one. |
| **Approving straight from the toast** | This needs a registered COM server plus a resident process, and the approval decision is carried by a Cordis **waterfall return value** that an out-of-process callback cannot inject. This plugin only **reminds** you; the approval itself still happens in the DSH UI. |
| **Persistent notifications** (`scenario="reminder"`) | By platform rule, that scenario is **silently ignored** unless the toast carries a button that activates **in the background**. With the previous non-goal in place, this one has no way to work. |
| **Jumping to a specific session on click** | The host half has no access to the client-side `ctx.uiWorkspace` service, so it cannot build a link to an individual session. A click only opens the DSH main interface. |
| **Declaring `@deepseek-ai/dsh-*` peerDependencies** | Intentional. DSH gates compatibility on declared peer ranges, so declaring them invites a block. This plugin relies only on stable public host APIs, so it declares none. |
| **A graphical settings page** | Out of scope for the first release; configure via `cordis.patch.yml`. |

## Known limitations

Observed in practice, stated plainly.

| Limitation | Detail |
|---|---|
| Notification attribution may show a generic value | The plugin signs its notifications with a Windows Toast application identifier, defaulting to `com.deepseek.dsh`, the identifier DSH Desktop registers with the system. If the identity in use is not registered on your system (some CLI profiles, for instance), the **source name and icon may appear as generic values** in the system notification centre. This does not affect a notification's content or click behaviour. |
| Foreground detection can miss | Detection matches on **window title / process name text**. When the title is rewritten — by a browser extension, a custom title, or over remote/virtual desktop — the match fails and a toast fires even while you are looking at DSH. |
| No approval notifications under Full Access | When DSH runs with full permissions (`approval: never`), the system never emits an approval request at all, so this plugin neither does nor can notify for it. Expected behaviour, not a defect. |
| The Desktop profile cannot be managed from the CLI | `dsh plugin --profile desktop` is refused outright by DSH: `profile "desktop" is managed exclusively by the Electron application`. This is existing DSH behaviour, not a defect in this plugin — use the in-app **Plugins** page. |

## FAQ

**Installed it, nothing happens.**
Host-side plugins mount at startup. Restart DSH.

**Will it still fire with the tab closed?**
Yes. It runs in the DSH main process, independent of any browser page.

**Does it support macOS or Linux?**
No — Windows only. See *Non-goals*.

**How do I silence it entirely?**
Set `mode` to `never` to disable all notifications. To drop just the sound while keeping the toasts, set the sound switch (`sound`) to `false`. Exact options are in *Configuration*.

**Why didn't clicking the toast take me back to that session?**
By design. A click opens the **DSH main interface** rather than a specific session, because the host half has no access to the client-side session navigation service. Session-level navigation is covered under *Non-goals*.

**Can I click the toast when I reach DSH over the CLI or a browser?**
Yes. The DSH interface URL needs an auth token, and the plugin attaches it when opening, so what you get is a **usable** interface rather than a 401 error page. (On Desktop, clicking a toast raises the DSH window instead.)

**No notification when an approval came up?**
First check that DSH is not in full-permission mode (`approval: never`). In that mode the system never emits an approval request, so the plugin never sees one — it is not an unimplemented feature. Switch to a mode that requires approval (such as `ask`) to exercise it.

## Implementation notes

| Item | Detail |
|---|---|
| Runs in | The DSH host process (Cordis host half), not the renderer |
| Delivery | Windows toasts via [`node-notifier`](https://www.npmjs.com/package/node-notifier); falls back to a PowerShell WinRT toast when unavailable (the fallback path has no click handling) |
| Foreground detection | Win32 `GetForegroundWindow` / `GetWindowText` / `GetWindowThreadProcessId`, with a short-lived result cache |
| Event sources | Public DSH host APIs (the `session/event`, `subagent/end`, jobs service, questions service, and so on) — no private internals |

## License

[MIT](LICENSE) © 2026 Zhang Zhaodong
