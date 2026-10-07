// dsh-win-notify — Windows 原生 toast 通知插件
//
// 监听完成事件 + 等待提问/审批事件（全部为 DSH 0.2.0-rc.2 实测 API，非猜测）：
//   1. 对话回合完成  ctx.on("session/event")  → turn/end  → reason.kind
//   2. 子代理完成    ctx.on("subagent/end")   → stopReason + lastAssistantMessage
//   3. 后台任务完成  ctx.jobs.events.subscribe({owners:"all"}) → ev.type==="settled"
//   4. 模型提问等你回答  ctx.on("user-questions/request") → 问题+选项，通知后立即 next() 放行
//   5. 工具审批等你决定  ctx.on("approval/request")       → toolName+reason，通知后立即 next() 放行
//
// 行为：
//   - mode:auto 时先探测 Windows 前台窗口：正在看 DSH 页面则不弹，切走/最小化/关页面才弹
//   - 宿主层集中队列：全局每分钟速率配额 + 同一工作区短窗内多会话完成合并为一条
//   - 免打扰时段：支持跨午夜时间窗；提问/审批（紧急）默认穿透
//   - 同一会话 3 秒内 job 完成 + 回合完成 合并为一条通知
//   - 模型提问事件：batch 只取第一题，同会话 3 秒内重复请求合并，只发通知不拦截应答
//   - 点击通知 → Desktop 下抬窗（dsh://open），否则打开带 token 的 DSH 页面
//   - node-notifier 不可用时降级为 PowerShell WinRT toast
//
// ⚠️ 铁律（改动前必读）：
//   - 顶层禁止 import "@deepseek-ai/dsh-settings" 任何子导出：0.2.0-rc.2 上会让整个插件
//     在 ESM 链接期 SyntaxError 整块加载失败，try/catch 救不了。
//   - 向 PowerShell 传中文必须走 -EncodedCommand(UTF-16LE base64)；`-Command` 内联中文
//     实测直接语法错。本文件所有含中文的 PS 调用都走 encodePs()。
//   - job 终态只有 completed / killed / failed —— 没有 "succeeded"（写错不会报错，只会
//     把「完成」显示成「已取消」，属于静默失败）。
//   - 端口取值必须用 `||` 而不是 `??`：port:0 是合法默认值（= 自动探测），`??` 会保留 0
//     生成 http://127.0.0.1:0 死链且零报错。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "dsh-win-notify";

// 通知插图：默认用 DSH 鲸鱼图标（可被配置覆盖）
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const DEFAULT_ICON = path.join(ASSETS_DIR, "dsh-whale.png");

const DEFAULTS = {
  mode: "auto",          // auto | always | never
  turns: true,           // 回合完成通知
  subagents: true,       // 子代理完成通知
  jobs: true,            // 后台任务通知
  questions: true,       // 模型提问等你回答（user-questions/request）通知
  approvals: true,       // 工具审批等你决定（approval/request）通知
  sound: true,           // Windows 提示音（具名音效，见 SOUND 表）
  port: 0,               // 0 = 自动取 ctx.webServer.port（拿不到才用 3080 兜底）
  mergeWindowMs: 3000,   // 同工作区多会话完成 / job+回合 的合并窗口
  minIntervalMs: 3000,   // 全局速率配额：相邻两条通知的最小间隔（0 = 不限）
  ratePerMinute: 20,     // 全局速率配额：每分钟最多发几条（0 = 不限）
  quietHours: "",        // 免打扰时段，如 "23:00-07:30"（支持跨午夜）；空 = 关闭
  quietUrgent: true,     // 免打扰时段内仍然放行紧急事件（提问 / 审批）
  desktopRaise: true,    // Desktop 下点击通知抬窗（dsh://open）而非开浏览器
  probeTimeoutMs: 5000,
  questionPreviewChars: 120, // 提问正文预览长度
  questionOptions: 3,    // 选项预览个数（0 = 不显示选项）
  summaryMaxChars: 120,
  icon: ""               // 通知插图（png/jpg/gif 绝对路径）；空 = 内置 DSH 鲸鱼图
};

// ---------------------------------------------------------------------------
// 音效：node-notifier 的 toaster 后端只认 "Notification." 前缀（lib/utils.js:431
// 会把任何其它取值静默改写成 Notification.Default），所以只能用 ms-winsoundevent
// 具名音。自定义 wav/mp3 一律不可用，本插件不提供该能力。
// ---------------------------------------------------------------------------
const SOUND = {
  turn: "Notification.IM",            // 对话完成
  subagent: "Notification.IM",        // 子任务完成
  job: "Notification.IM",             // 后台任务完成
  question: "Notification.SMS",       // 模型提问
  approval: "Notification.Default",   // 工具审批
  error: "Notification.Reminder",     // 出错 / 中断
  interrupted: "Notification.Reminder",
  generic: "Notification.Default"
};

// ---------------------------------------------------------------------------
// PowerShell 桥
// ---------------------------------------------------------------------------
// 把脚本编成 UTF-16LE base64 走 -EncodedCommand。内联 -Command 传中文实测语法错，
// 这条路径是唯一可靠的。
function encodePs(script) {
  try {
    return Buffer.from(String(script), "utf16le").toString("base64");
  } catch { return ""; }
}

// PowerShell 单引号字面量：内部的单引号翻倍。
function psLiteral(s) {
  return "'" + String(s ?? "").replace(/'/g, "''") + "'";
}

// XML 数字实体转义：只保留安全可打印 ASCII，中文 / 引号 / & / < > / 控制符一律写成
// &#<码点>;。整段 XML 落到纯 ASCII 后，即使 PowerShell 输出编码被改成 GBK 也不会乱码，
// 更不会抛 0xC00CE56D（UTF-8 无 BOM 的 XML 会抛的那个）。
function xmlText(s) {
  return Array.from(String(s ?? ""))
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp >= 0x20 && cp <= 0x7e && ch !== "&" && ch !== "<" && ch !== ">" && ch !== '"' && ch !== "'") return ch;
      return `&#${cp};`;
    })
    .join("");
}

function runPowerShellEncoded(script, { detached = true } = {}) {
  try {
    const b64 = encodePs(script);
    if (!b64) return;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
      { windowsHide: true, stdio: "ignore", detached }
    );
    child.on("error", () => {}); // 通知链路绝不阻塞主流程
    child.unref();
  } catch {}
}

// ---------- 文本工具 ----------
function textOf(message) {
  try {
    const blocks = message?.content;
    if (!Array.isArray(blocks)) return "";
    return blocks
      .map((b) => (b && typeof b.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
  } catch { return ""; }
}

// 从 assistant/message 事件的 data 里提取正文，只留 type==="text"，过滤 reasoning/工具调用
function assistantTextOf(data) {
  try {
    const blocks = data?.message?.content;
    if (!Array.isArray(blocks)) return "";
    return blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ")
      .trim();
  } catch { return ""; }
}

function truncate(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
}

function fmtDuration(seconds) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${seconds} 秒`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

// job 投影（view(job)）的时长：startedAt / finishedAt 都是毫秒时间戳
function fmtJobDuration(job) {
  if (!job || !job.finishedAt || !job.startedAt) return "";
  return fmtDuration(Math.round((job.finishedAt - job.startedAt) / 1000));
}

// 从绝对路径取最后一段（工作区/会话目录名兜底）
function basenameOf(p) {
  try {
    if (typeof p !== "string" || p === "") return "";
    const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || "";
  } catch { return ""; }
}

// ---------- 提问摘要 ----------
// 把 user-questions/request 的 questions batch 压缩成一条 toast 文案：
// "问题正文 · 选项1 / 选项2 / 选项3"。batch 多题只取第一题（一次提问只弹一条）。
function questionSummaryOf(request, previewChars, optionCount) {
  try {
    const qs = Array.isArray(request?.questions) ? request.questions : [];
    const first = qs.find((q) => q && typeof q.question === "string" && q.question.trim() !== "")
      ?? (qs.length > 0 ? qs[0] : undefined);
    if (!first) return "";
    const header = first.header && typeof first.header === "string" ? truncate(first.header, 24) : "";
    const question = truncate(first.question, previewChars || 120);
    const opts = (Array.isArray(first.options) ? first.options : [])
      .map((o) => o && (typeof o.label === "string" || typeof o.text === "string")
        ? truncate(o.label ?? o.text, 24)
        : "")
      .filter(Boolean)
      .slice(0, Math.max(0, optionCount ?? 3));
    const parts = [header && question !== header ? `【${header}】${question}` : question];
    if (opts.length > 0) parts.push(opts.join(" / "));
    return parts.join(" · ");
  } catch { return ""; }
}

// ---------- Windows 前台窗口探测 ----------
// 返回 true = 用户正在看 DSH 页面（不弹通知）
// 纯 ASCII 脚本，可以安全走 -Command（只有含中文才必须 -EncodedCommand）。
const PROBE_PS = `
$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
Add-Type -TypeDefinition $sig
$h = [DshFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[DshFg]::GetWindowText($h, $sb, 512) | Out-Null
$p = 0
[DshFg]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
$n = ''
try { $n = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
Write-Output ("{0}|{1}" -f $n, $sb.ToString())
`;

// 进程名白名单。必须包含 "deepseek harness"：BROWSER_PROCS 原本没有任何 electron 项，
// 而桌面版主窗口的标题是 "<会话名> — DeepSeek Harness"，早期只靠标题正则兜住。
const BROWSER_PROCS = [
  "chrome", "msedge", "firefox", "brave", "opera", "vivaldi",
  "msedgewebview2", "360chrome", "qqbrowser", "sogouexplorer", "browser",
  "deepseek harness"
];

function parseProbe(out, port) {
  try {
    const line = (out || "").trim().split("\n")[0] || "";
    const sep = line.indexOf("|");
    if (sep < 0) return false;
    const proc = line.slice(0, sep).toLowerCase();
    const title = line.slice(sep + 1) || "";
    // 标题里出现任意回环地址端口即可判定（旧代码只匹配固定的 3080/3088，漏掉实际端口）
    if (/deepseek harness/i.test(title)) return true;
    if (/127\.0\.0\.1:\d+|localhost:\d+/i.test(title)) return true;
    if (port && title.includes(`:${port}`)) return true;
    if (BROWSER_PROCS.includes(proc) && /localhost|127\.0\.0\.1/i.test(title)) return true;
    return false;
  } catch { return false; }
}

let probeState = { promise: null, value: false, at: 0 };

function probeForeground(port, timeoutMs) {
  const now = Date.now();
  if (probeState.promise) return probeState.promise;
  if (probeState.at !== 0 && now - probeState.at < 2000) return Promise.resolve(probeState.value);
  probeState.promise = new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PROBE_PS], { windowsHide: true });
    } catch { settle(false); return; }
    let out = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      probeState.value = value;
      probeState.at = Date.now();
      probeState.promise = null;
      resolve(value);
    };
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", () => settle(false));
    const timer = setTimeout(() => { try { child.kill(); } catch {} settle(false); }, timeoutMs || 5000);
    child.on("close", () => { clearTimeout(timer); settle(parseProbe(out, port)); });
  });
  return probeState.promise;
}

// ---------- 通知发送 ----------
let notifier = null;
let notifierLoadAttempted = false;

async function loadNotifier() {
  if (notifierLoadAttempted) return notifier;
  notifierLoadAttempted = true;
  try {
    const mod = await import("node-notifier");
    notifier = mod?.default ?? mod ?? null;
  } catch { notifier = null; }
  return notifier;
}

// 打开一个 URL / 自定义协议。cmd 只用做一次 start，不阻塞主流程。
function openUrl(url) {
  try {
    if (typeof url !== "string" || url === "") return;
    spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch {}
}

// Windows 应用署名用的 AppID。原值 "DSH" 从未注册（Get-StartApps 275 条精确匹配 0），
// 改为桌面端官方值 com.deepseek.dsh；降级路径的 CreateToastNotifier 必须用同一个值，
// 否则主/降级署名不一致。
// ⚠️ 诚实口径：仅证实两种取值都能正常 Show()（snoretoast 退出码 2/3，均非 -1 Failed），
//    **未做视觉对比**，故此处不断言 toast 上实际显示的应用名。
const APP_ID = "com.deepseek.dsh";

/**
 * @param {{title:string,message:string,url?:string,sound?:string}} note
 */
async function sendToast(note, cfg) {
  const { title, message, url } = note;
  // 具名音（Notification.*）；sound:false = 静音。其它取值会被 node-notifier 静默改写。
  const soundName = cfg.sound === false ? undefined : (note.sound || SOUND.generic);
  const n = await loadNotifier();
  if (n) {
    await new Promise((resolve) => {
      try {
        n.notify({
          title,
          message,
          sound: soundName || false,
          wait: true,
          appID: APP_ID,
          timeout: 8,
          icon: cfg.icon || DEFAULT_ICON,
        }, (err, response) => {
          if (!err && (response === "activate" || response === "click") && url) openUrl(url);
          resolve();
        });
      } catch { resolve(); }
    });
    return;
  }
  // 降级：PowerShell WinRT toast（无点击跳转，尽力而为）。
  // 中文一律走 XML 数字实体 + -EncodedCommand，两重保险。
  const ps = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$xs = $t.GetElementsByTagName('text')",
    `$xs.Item(0).AppendChild($t.CreateTextNode(${psLiteral(xmlText(title))})) | Out-Null`,
    `$xs.Item(1).AppendChild($t.CreateTextNode(${psLiteral(xmlText(message))})) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(APP_ID)}).Show($toast)`,
  ].join("\n");
  runPowerShellEncoded(ps);
}

// ---------- 插件主体 ----------
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const titles = new Map();
  const firstUserText = new Map();
  const lastAssistantText = new Map();
  const turnStarts = new Map();
  const pendingJobs = new Map();
  const lastQuestionAt = new Map();
  const warn = (msg) => { try { ctx.logger?.warn?.(msg); } catch {} };

  // ---------- 端口 / 鉴权 URL（P0-2） ----------
  // ctx.inject 是异步的：回调要等服务就绪才跑，所以不在回调里定义取 URL 的函数，
  // 而是把结果存进闭包变量，取值侧统一兜底。
  let webPort = 0;
  let authUrlFn = null;
  try {
    ctx.inject(["connection", "webServer"], (c) => {
      try { webPort = c.webServer?.port || 0; } catch {}
      try {
        authUrlFn = (u) => {
          try { return c.connection.authenticatedUrl(u) || u; } catch { return u; }
        };
      } catch {}
    });
  } catch (e) { warn(`dsh-win-notify inject(connection,webServer): ${e?.message || e}`); }

  // 惰性兜底：inject 没触发（例如 connection 不在本组合里）时直接从 ctx 取。
  const resolveWebPort = () => {
    // ⚠️ 必须 `||`：port:0 是合法默认值（自动探测），`??` 会保留 0 生成死链
    if (cfg.port) return cfg.port;          // 显式配置优先
    if (webPort) return webPort;
    try { return ctx.get("webServer")?.port || 0; } catch { return 0; }
  };

  // 点击通知要打开的地址：Desktop 抬窗优先，否则开带 token 的页面。
  // 地址延迟到「点击那一刻」才解析（那时端口早已就绪），避免启动期取到 0。
  const clickTargetOf = () => {
    const isDesktop = (() => { try { return !!process.versions?.electron; } catch { return false; } })();
    if (isDesktop && cfg.desktopRaise !== false) return "dsh://open";
    const port = cfg.port || resolveWebPort() || 3080;
    const clean = `http://127.0.0.1:${port}`;
    if (authUrlFn) { try { return authUrlFn(clean) || clean; } catch { return clean; } }
    return clean;
  };

  // ---------- 免打扰时段（B3） ----------
  // 支持 "23:00-07:30"（跨午夜）与 "09:00-12:00,14:00-18:00"（多段，逗号分隔）。
  const parseMinutes = (text) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
    if (!m) return undefined;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return undefined;
    return h * 60 + mi;
  };
  const quietWindows = (() => {
    const out = [];
    for (const seg of String(cfg.quietHours || "").split(",")) {
      const part = seg.trim();
      if (!part) continue;
      const m = /^(.+?)\s*[-~—]\s*(.+)$/.exec(part);
      if (!m) continue;
      const from = parseMinutes(m[1]);
      const to = parseMinutes(m[2]);
      if (from === undefined || to === undefined) continue;
      out.push({ from, to });
    }
    return out;
  })();

  const inQuietHours = () => {
    if (quietWindows.length === 0) return false;
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    // from <= to：普通窗；否则跨午夜（cur >= from 或 cur < to）
    return quietWindows.some(({ from, to }) => (from <= to
      ? cur >= from && cur < to
      : cur >= from || cur < to));
  };

  // ---------- 全局速率配额（B2） ----------
  const sentAt = [];
  const rateAllows = () => {
    const now = Date.now();
    const minGap = Number(cfg.minIntervalMs);
    if (Number.isFinite(minGap) && minGap > 0 && sentAt.length > 0) {
      if (now - sentAt[sentAt.length - 1] < minGap) return false;
    }
    const perMin = Number(cfg.ratePerMinute);
    if (Number.isFinite(perMin) && perMin > 0) {
      while (sentAt.length > 0 && now - sentAt[0] > 60000) sentAt.shift();
      if (sentAt.length >= perMin) return false;
    }
    return true;
  };

  const shouldNotify = async (urgent = false) => {
    if (cfg.mode === "never") return false;
    if (inQuietHours() && !(urgent && cfg.quietUrgent !== false)) return false;
    if (!rateAllows()) return false;
    if (cfg.mode === "always") return true;
    try { return !(await probeForeground(resolveWebPort(), cfg.probeTimeoutMs)); } catch { return true; }
  };

  const emit = (note) => {
    sentAt.push(Date.now());
    sendToast({ ...note, url: note.url ?? clickTargetOf() }, cfg).catch(() => {});
  };

  // ---------- 工作区 / 会话双标注（B1） ----------
  // 工作区优先走 ctx.workspaceRegistry（entity 有 title / path / sessionIds）；
  // 取不到就退回会话 header.cwd 的目录名。全程 try/catch，绝不让标注拖垮通知。
  const workspaceTitleOf = (sid) => {
    try {
      const reg = ctx.get("workspaceRegistry");
      if (reg && sid && typeof reg.list === "function") {
        const list = reg.list();
        if (Array.isArray(list)) {
          for (const ws of list) {
            let ids;
            try { ids = ws?.sessionIds; } catch { continue; }
            if (Array.isArray(ids) && ids.includes(sid)) {
              const t = (typeof ws?.title === "string" && ws.title) || basenameOf(ws?.path);
              if (t) return t;
            }
          }
        }
      }
    } catch {}
    try {
      const s = ctx.get("sessions")?.get?.(sid);
      const fromCwd = basenameOf(s?.header?.cwd);
      if (fromCwd) return fromCwd;
    } catch {}
    return "";
  };

  const sessionLabel = (sid, session) => {
    const t = titles.get(sid);
    if (t) return truncate(t, 40);
    try {
      const events = session?.events;
      if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i]?.type === "session/title" && events[i]?.data?.title) {
            titles.set(sid, events[i].data.title);
            return truncate(events[i].data.title, 40);
          }
        }
        for (let i = 0; i < events.length; i += 1) {
          if (events[i]?.type === "user/message") {
            const txt = textOf(events[i].data);
            if (txt) { firstUserText.set(sid, txt); return truncate(txt, 40); }
          }
        }
      }
    } catch {}
    const f = firstUserText.get(sid);
    return f ? truncate(f, 40) : sid;
  };

  // 正文组装（B1）：「【工作区】会话 · 正文」
  // 会话名是「归属标注」，不是正文的一部分：如果正文本身已经是会话名（例如回合完成时
  // label 退化成会话首选消息），必须去重，否则会打出 "会话一号 · 会话一号 · 1 秒"。
  const composeHeadline = (sid, session, body) => {
    const ws = sid ? workspaceTitleOf(sid) : "";
    const sess = sid ? sessionLabel(sid, session) : "";
    const text = String(body ?? "").trim();
    const wsTag = ws ? `【${truncate(ws, 24)}】` : "";
    const sessTag = sess && sess !== ws ? truncate(sess, 24) : "";
    if (!wsTag && !sessTag) return text;
    if (!text) return `${wsTag}${sessTag}`;
    if (!sessTag || text.includes(sessTag)) return `${wsTag}${text}`;
    return `${wsTag}${sessTag} · ${text}`;
  };

  // ---------- 宿主层集中队列：同工作区短窗合并（B2） ----------
  // 宿主是唯一天然去重点（渲染层做不到跨浏览器/跨地址）。按工作区分桶，
  // mergeWindowMs 内的多条完成合并成一条，避免多会话并行时刷屏。
  const mergeKeyOf = (sid) => {
    const ws = sid ? workspaceTitleOf(sid) : "";
    return ws ? `ws:${ws}` : `sid:${sid || "-"}`;
  };

  /** @type {Map<string, {notes:any[], timer:any, at:number}>} */
  const buckets = new Map();

  const composeBucket = (key, notes) => {
    if (notes.length === 1) return notes[0];
    const total = notes.length;
    const done = notes.filter((n) => n.tone === "ok").length;
    const bad = notes.filter((n) => n.tone === "bad").length;
    const wsName = key.startsWith("ws:") ? key.slice(3) : "";
    let title;
    let tone;
    if (bad === 0) { title = `✅ DSH 完成 ×${total}`; tone = "ok"; }
    else if (done === 0) { title = `❌ DSH 出错 ×${total}`; tone = "bad"; }
    else { title = `⚠️ DSH 部分完成（${done} 成 / ${bad} 错）`; tone = "warn"; }
    const parts = notes.map((n) => truncate(n.headline || "", 40)).filter(Boolean);
    const head = wsName ? `【${truncate(wsName, 24)}】` : "";
    const message = truncate(`${head}${parts.join(" / ")}`, cfg.summaryMaxChars || 120);
    const sound = tone === "bad" ? SOUND.error : (notes[0].sound || SOUND.generic);
    return {
      title,
      message: message || `${total} 个会话已完成`,
      tone,
      sound,
      urgent: notes.some((n) => n.urgent),
    };
  };

  const flushBucket = (key) => {
    const bucket = buckets.get(key);
    if (!bucket) return;
    buckets.delete(key);
    clearTimeout(bucket.timer);
    const note = composeBucket(key, bucket.notes);
    if (note) emit({ title: note.title, message: note.message, sound: note.sound });
  };

  const enqueue = (sid, note, opts = {}) => {
    const key = opts.mergeKey || mergeKeyOf(sid);
    const windowMs = Number.isFinite(Number(cfg.mergeWindowMs)) ? Math.max(0, Number(cfg.mergeWindowMs)) : 0;
    if (windowMs <= 0) { emit(note); return; }
    const existing = buckets.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.notes.push(note);
      existing.at = Date.now();
      existing.timer = setTimeout(() => flushBucket(key), windowMs);
      return;
    }
    const bucket = { notes: [note], at: Date.now(), timer: null };
    bucket.timer = setTimeout(() => flushBucket(key), windowMs);
    buckets.set(key, bucket);
  };

  // ---------- 通知正文构造（返回 note 或 undefined） ----------
  const buildTurnNote = async (sid, kind, duration, mergedJob, reason, session) => {
    if (!cfg.turns) return undefined;
    if (mergedJob) {
      if (!(await shouldNotify(false))) return undefined;
      const label = mergedJob.label ? truncate(mergedJob.label, 40) : mergedJob.id;
      const dur = fmtJobDuration(mergedJob);
      // 终态只有 completed / killed / failed
      const ok = mergedJob.status === "completed";
      const failed = mergedJob.status === "failed";
      return {
        title: ok ? "✅ DSH 任务完成" : (failed ? "❌ DSH 任务失败" : "⚠️ DSH 任务已取消"),
        message: composeHeadline(sid, session, `${label}${dur ? " · " + dur : ""}${kind === "error" ? " · 回合也出错" : ""}`),
        headline: label,
        tone: ok ? "ok" : (failed ? "bad" : "warn"),
        sound: ok ? SOUND.job : SOUND.error,
      };
    }
    if (!(await shouldNotify(false))) return undefined;
    const cur = lastAssistantText.get(sid);
    const label = cur ? truncate(cur, cfg.summaryMaxChars) : sessionLabel(sid, session);
    const dur = duration ? ` · ${fmtDuration(duration)}` : "";
    if (kind === "completed") {
      return { title: "✅ DSH 对话完成", message: composeHeadline(sid, session, `${label}${dur}`), headline: label, tone: "ok", sound: SOUND.turn };
    }
    if (kind === "error") {
      const err = truncate(reason?.error?.message || "", 80);
      return { title: "❌ DSH 出错", message: composeHeadline(sid, session, `${label}${dur}${err ? " · " + err : ""}`), headline: label, tone: "bad", sound: SOUND.error };
    }
    const why = { aborted: "已中断", "max-tokens": "超长截断", blocked: "被拒绝" }[kind] || String(kind);
    return { title: "⚠️ DSH 对话中断", message: composeHeadline(sid, session, `${label} · ${why}${dur}`), headline: label, tone: "warn", sound: SOUND.interrupted };
  };

  // 提取事件归属的会话 id：优先事件自带 agent 投影（agent.id === session.id，
  // 见 dsh-agent 的 `if (id !== agent.session.id) throw`），其次取 request 上的 session 字段。
  const ownerSessionOf = (request) => {
    try {
      const aid = request?.agent?.id ?? request?.agent?.session?.id;
      if (typeof aid === "string" && aid !== "") return aid;
      const sid = request?.sessionId || request?.owner;
      return typeof sid === "string" && sid !== "" ? sid : undefined;
    } catch { return undefined; }
  };

  // 模型提问等你回答：发一条 toast，把用户拉回 DSH 页面点选
  const sendQuestionNotification = async (request) => {
    if (!cfg.questions) return;
    if (!(await shouldNotify(true))) return; // 提问 = 紧急，穿透免打扰
    const sid = ownerSessionOf(request);
    const summary = questionSummaryOf(request, cfg.questionPreviewChars, cfg.questionOptions);
    const text = composeHeadline(sid, undefined, summary);
    emit({
      title: "🤔 DSH 在等你回答",
      message: text || "模型提问待处理，切回 DSH 页面查看",
      sound: SOUND.question,
      urgent: true,
    });
  };

  // 工具审批等你决定（P0-3）
  const sendApprovalNotification = async (request) => {
    if (!cfg.approvals) return;
    if (!(await shouldNotify(true))) return; // 审批 = 紧急，穿透免打扰
    const sid = ownerSessionOf(request);
    const tool = truncate(request?.toolName || "", 40);
    const reason = truncate(request?.reason || "", 80);
    const body = [tool, reason].filter(Boolean).join(" · ");
    emit({
      title: "🔐 DSH 等待你审批",
      message: composeHeadline(sid, undefined, body) || "工具调用等待授权，切回 DSH 页面处理",
      sound: SOUND.approval,
      urgent: true,
    });
  };

  // 5) 工具审批（approval/request 事件，waterfall 语义）
  //    ⚠️ 必须立即 return next() 放行，否则请求永不落定、审批 UI 卡死。
  //    本机 approval 策略是 never（全权限），此路径本机默认不可达，
  //    需临时切 workspace-write / approval:ask 才能验证。
  ctx.on("approval/request", async (request, next) => {
    try {
      if (cfg.approvals && request) {
        const sid = ownerSessionOf(request);
        const now = Date.now();
        const last = lastQuestionAt.get(sid);
        if (last === undefined || now - last > cfg.mergeWindowMs) {
          lastQuestionAt.set(sid, now);
          sendApprovalNotification(request).catch(() => {}); // 不 await：失败也不阻塞审批
        }
      }
    } catch (e) { warn(`dsh-win-notify approval/request: ${e?.stack || e}`); }
    return next();
  });

  // 4) 模型提问等你回答（user-questions/request 事件，waterfall 语义）
  //    此事件是 "回合仍在进行但模型在等你" 的唯一信号；回合此时未 end，turn/end 通知不会触发。
  //    只发通知不吞请求：立即 return next() 放行给 UI 应答器；任何异常也放行。
  ctx.on("user-questions/request", async (request, next) => {
    try {
      if (cfg.questions && request && Array.isArray(request.questions) && request.questions.length > 0) {
        // 同会话 3 秒内去重：连续两次提问只提醒一次
        const sid = ownerSessionOf(request);
        const now = Date.now();
        const last = lastQuestionAt.get(sid);
        if (last === undefined || now - last > cfg.mergeWindowMs) {
          lastQuestionAt.set(sid, now);
          sendQuestionNotification(request).catch(() => {}); // 不 await：失败也不阻塞问答
        }
      }
    } catch (e) { warn(`dsh-win-notify user-questions/request: ${e?.stack || e}`); }
    return next();
  });

  const sendSubagentNotification = async (info) => {
    if (!cfg.subagents) return;
    if (!(await shouldNotify(false))) return;
    const ok = info.stopReason === "completed";
    const summary = truncate(info.lastAssistantMessage || "", cfg.summaryMaxChars);
    const label = summary || `子代理 ${info.id || ""}`;
    emit({
      title: ok ? "✅ 子任务完成" : `⚠️ 子任务结束（${info.stopReason || "error"}）`,
      message: label,
      headline: label,
      tone: ok ? "ok" : "warn",
      sound: ok ? SOUND.subagent : SOUND.error,
    });
  };

  // ---------- 后台任务完成（P0-1） ----------
  // 0.2.0-rc.2 已无 ctx.jobs.onJobDone（0 命中）。新 API 是
  // ctx.jobs.events.subscribe({owners:"all"}, listener)，事件形状：
  //   { type:"settled", job: view(job), cause, awaited }   ← job.* 嵌套一层
  //   job.status ∈ completed | killed | failed             ← 没有 "succeeded"
  //   job.owner = owner?.id                                ← 不是 ownerSession
  const buildJobNote = async (job) => {
    if (!cfg.jobs) return undefined;
    const sid = job?.owner;
    const label = job?.label ? truncate(job.label, 40) : String(job?.id ?? "");
    const dur = fmtJobDuration(job);
    const detail = job?.detail ? truncate(job.detail, 80) : "";
    if (!(await shouldNotify(false))) return undefined;
    if (job?.status === "completed") {
      return { title: "✅ DSH 任务完成", message: composeHeadline(sid, undefined, `${label}${dur ? " · " + dur : ""}`), headline: label, tone: "ok", sound: SOUND.job };
    }
    if (job?.status === "failed") {
      return { title: "❌ DSH 任务失败", message: composeHeadline(sid, undefined, `${label}${dur ? " · " + dur : ""}${detail ? " · " + detail : ""}`), headline: label, tone: "bad", sound: SOUND.error };
    }
    return { title: "⚠️ DSH 任务已取消", message: composeHeadline(sid, undefined, label), headline: label, tone: "warn", sound: SOUND.interrupted };
  };

  const deliverJobNote = (job, ownerId) => {
    buildJobNote(job)
      .then((note) => { if (note) enqueue(ownerId, note, ownerId ? {} : { mergeKey: "jobs" }); })
      .catch(() => {});
  };

  // 1) 会话事件：标题/摘要收集 + 回合完成判定
  ctx.on("session/event", (session, event) => {
    try {
      const sid = session?.id;
      if (!sid) return;
      if (event?.type === "session/title") { titles.set(sid, event.data?.title ?? ""); return; }
      if (event?.type === "user/message") {
        if (!firstUserText.has(sid)) firstUserText.set(sid, textOf(event.data));
        return;
      }
      if (event?.type === "assistant/message") {
        const txt = assistantTextOf(event.data);
        if (txt) lastAssistantText.set(sid, txt);
        return;
      }
      if (event?.type === "turn/start") {
        turnStarts.set(sid, { turn: event.data?.turn, time: event.time ?? Date.now() });
        lastAssistantText.delete(sid);
        return;
      }
      if (event?.type !== "turn/end") return;
      const reason = event.data?.reason;
      const kind = reason?.kind ?? "completed";
      const start = turnStarts.get(sid);
      const duration = start && start.turn === event.data?.turn
        ? Math.round(((event.time ?? Date.now()) - start.time) / 1000)
        : undefined;
      const pending = pendingJobs.get(sid);
      const mergedJob = pending && Date.now() - pending.at <= cfg.mergeWindowMs ? pending.job : undefined;
      if (pending && mergedJob) {
        clearTimeout(pending.timeout);
        pendingJobs.delete(sid);
      }
      buildTurnNote(sid, kind, duration, mergedJob, reason, session)
        .then((note) => { if (note) enqueue(sid, note); })
        .catch(() => {});
    } catch (e) { warn(`dsh-win-notify session/event: ${e?.stack || e}`); }
  });

  // 2) 子代理完成
  ctx.on("subagent/end", (info) => {
    try { sendSubagentNotification(info || {}).catch(() => {}); } catch (e) { warn(`dsh-win-notify subagent/end: ${e?.stack || e}`); }
  });

  // 3) 后台任务完成（有 owner 会话的进入合并窗口，等待可能的回合完成）
  const jobs = ctx.get("jobs");
  if (jobs && jobs.events && typeof jobs.events.subscribe === "function") {
    try {
      jobs.events.subscribe({ owners: "all" }, (ev) => {
        try {
          if (!ev || ev.type !== "settled") return;
          if (!cfg.jobs) return;
          const job = ev.job;
          if (!job) return;
          const jobOwner = job.owner;
          if (jobOwner) {
            const at = Date.now();
            const timeout = setTimeout(() => {
              pendingJobs.delete(jobOwner);
              deliverJobNote(job, jobOwner);
            }, cfg.mergeWindowMs);
            pendingJobs.set(jobOwner, { timeout, job, at });
          } else {
            deliverJobNote(job, undefined);
          }
        } catch (e) { warn(`dsh-win-notify jobs settled: ${e?.stack || e}`); }
      });
    } catch (e) {
      warn(`dsh-win-notify: jobs.events.subscribe() failed: ${e?.stack || e}`);
    }
  } else {
    warn("dsh-win-notify: jobs service unavailable; background-job notifications disabled");
  }

  try {
    ctx.logger?.info?.(`dsh-win-notify loaded: mode=${cfg.mode} turns=${cfg.turns} subagents=${cfg.subagents} jobs=${cfg.jobs} questions=${cfg.questions} approvals=${cfg.approvals} sound=${cfg.sound} quiet="${cfg.quietHours}"`);
  } catch {}

  return () => {
    for (const { timeout } of pendingJobs.values()) clearTimeout(timeout);
    pendingJobs.clear();
    for (const bucket of buckets.values()) clearTimeout(bucket.timer);
    buckets.clear();
    lastQuestionAt.clear();
  };
}
