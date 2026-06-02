# android-debug-mcp

> English: [README.md](./README.md)

一个本地 **stdio MCP server**,用于 **Android 应用层调试取证**。它让 MCP agent
以「会话隔离、全程留痕」的方式通过 `adb` 驱动真机——拉起 app、复现 bug、操作
屏幕,并把 logcat / 崩溃 / 截图收进一个自洽的 run 目录。

它是 *证据优先* 的:每次工具调用都被记录,每个 run 都是磁盘上一个可检视、可打包、
可转交同事的目录。它刻意 **不做** 基于元素的 UI 自动化(不碰 AccessibilityService、
不按控件树点击)——见 [与 mobile-mcp 共存](#与-mobile-mcp-共存)。

状态:**0.7.4** —— 24 个工具全部注册;v1 + v2 验收场景与真机 e2e 均通过。

## 前置要求

- **Bun ≥ 1.1** —— 运行时(`package.json` 的 `engines.bun`)。
- **`adb`** 在 `PATH` 上(Android platform-tools),或用 `ADB_PATH` 指向该二进制。
- 一台开了 **USB 调试** 并已授权的 Android 设备(或模拟器):`adb devices`
  应能看到它处于 `device` 状态。
- 仅 `android_debug_input_text` 需要:设备上装好 **ADBKeyBoard** 辅助 APK——
  见 [文本输入](#文本输入adbkeyboard)。

## 接入 MCP host

server 以 stdio 讲 MCP。host 通过 `npx` 直接从这个 GitHub 仓库拉取并运行——
不用 clone、不用全局安装、无构建步骤。`PATH` 上要有 bun(server 以 TypeScript
在 Bun 下运行)。

**Claude Code / Cursor** —— 加进 `mcp.json`(Cursor)或 `.mcp.json`(Claude Code):

```json
{
  "mcpServers": {
    "android-debug": {
      "command": "npx",
      "args": ["-y", "github:est7/android-debug-mcp"]
    }
  }
}
```

Claude Code CLI 等价写法:

```sh
claude mcp add android-debug -- npx -y github:est7/android-debug-mcp
```

`npx` 首次运行会 clone + 安装(几秒),之后走缓存。要锁版本用
`github:est7/android-debug-mcp#v0.1.0`;不带后缀则跟 `main`。`bunx` 可替代 `npx`。

### run 目录位置 —— `ANDROID_DEBUG_MCP_RUN_ROOT`(可选)

默认情况下 server 把 run 目录写到 `<项目>/.android-debug-runs/`——`<项目>` 由
你启动 MCP host 时所在目录的 `git rev-parse --show-toplevel` 推出。**只要在要
调试的 Android 项目里启动 host,就无需任何配置。**

只有想覆盖这个默认值时才设 `ANDROID_DEBUG_MCP_RUN_ROOT`。完整解析顺序(§ C-3):

1. `start_session({ projectRoot })` 参数(若给)→ `<projectRoot>/.android-debug-runs/`
2. `ANDROID_DEBUG_MCP_RUN_ROOT` 环境变量 → 原样采用
3. server 当前目录的 `git rev-parse --show-toplevel` → `<top>/.android-debug-runs/`(**即默认值**)
4. 兜底(cwd 不在 git 仓库内)→ `~/.android-debug-mcp/runs/`

要覆盖,就在上面的配置里加一个 `env` 块:

```json
"env": { "ANDROID_DEBUG_MCP_RUN_ROOT": "/abs/path/to/runs" }
```

一个 run 目录是 `<runRoot>/<package>/u<userId>/<runId>/`,内含
`metadata.json`、`events.jsonl`、`commands.jsonl`、`logcat.jsonl`、
`logcat.raw.txt`、`crash.jsonl`、`summary.md`,以及一个 `artifacts/` 子目录。

## 24 个工具

每个工具都叫 `android_debug_*`。工具 **成功** 时返回 `structuredContent`;
**可恢复的失败** 则返回 `{ isError: true }`,把 JSON 形态的 `{error, message, …}`
放在 `content[0].text` 里、且 **不带** `structuredContent`——agent 据此分支处理;
它绝不会以裸协议错误的形式抛出。

会话按 `(deviceSerial, userId, packageName)` 三元组单例——一个 app 在一台设备上
同一时刻只有一个活跃 run。每次交互 / 证据调用都带上 `start_session` 返回的 `runId`。

### 会话生命周期

| 工具 | 作用 |
|---|---|
| `start_session` | 拿单例锁、落 run 目录、采集 app/设备/git 溯源,可选拉起 app。返回后续所有调用要带的 `runId`(以及 `versionName`/`versionCode`、`profileName`)。 |
| `stop_session` | finalize:封存证据、flush 并关闭各 jsonl 流、释放锁。 |
| `get_app_state` | 只读实时快照:前台 activity、pids、已装版本、近期 `exit-info`、会话健康。 |
| `get_run_summary` | 一个 run 的完整 Markdown 报告 + 结构化 metadata——溯源、计数、崩溃列表、事件时间线。 |
| `app_control` | 驱动活跃会话的 app 生命周期:launch / stop / force-stop / restart。 |
| `clear_app_data` | `pm clear` 抹掉 app 数据,回到首次启动状态。 |

### 设备与 run

| 工具 | 作用 |
|---|---|
| `list_devices` | 列 adb 可见设备(含 offline / 未授权),带 model / api-level / abi。 |
| `list_runs` | 列 run 根目录下的 run,最新在前,分页。 |

### 屏幕检视与交互

| 工具 | 作用 |
|---|---|
| `capture` | 截图和/或 UI 层级 dump。`annotateElements:true` 叠加带编号的可点目标并返回元素映射。 |
| `list_elements` | 列屏上可交互元素(resource-id / 文本 / desc / bounds + 预算好的点击中心)。server 端过滤:`resourceIdContains`、`clickableOnly`、`textContains`、`inViewport` 等。 |
| `tap` · `long_press` · `swipe` | 活跃会话上的坐标手势。 |
| `tap_node` | 点一个坐标 **并** 解析命中了哪个节点 + 最近的 resource-id 源锚点 + 祖先链——一次调用搞定。 |
| `send_key` | 发一个硬件/导航键(BACK、HOME、ENTER…)。 |
| `input_text` | 经 ADBKeyBoard 往焦点输入框打字;`sensitive:true` 只记长度占位符。 |
| `map_ui_node_to_source` | 把点中的节点映射回源码——layout-id 声明、所属屏幕、代码引用。 |

### 证据与取证

| 工具 | 作用 |
|---|---|
| `mark_event` | 往 `events.jsonl` 追加一个命名时间标记——锚住一个时间点,供后续按窗口取证。 |
| `search_logs` | 按子串 / level / tag / pid / mark 窗口检索已解析的 logcat。`count:true + groupBy` 做日志量聚合。 |
| `search_evidence` | 检索 profile 声明的证据源(如 `poppo_http`),分页,按需从设备拉取——带 `bytesPulled` 成本记账。 |
| `extract_evidence_context` | marker 周围的记录:单源分页,**或** 多源因果时间线,把 logcat + events + profile 源按 `tsMs` 归并(logcat 默认收敛到 app 的 pids、丢掉噪声 tag)。 |
| `extract_crash_context` | run 里某次崩溃周围的原始日志上下文。 |
| `perf_snapshot` | 活跃会话的实时性能快照(cpu / mem / gfx)。 |
| `collect_bundle` | 把 run 目录打成可携带的 bundle——转交同事或附进工单。 |

> profile 相关的工具(`search_evidence`、`extract_evidence_context` 里的 profile
> 源)只有在 `start_session` 加载了 project profile 时才生效。把 `projectRoot`
> 指向带 `.android-debug-mcp/profile.json` 的仓库;否则 `start_session` 返回
> `profileName: null`,这些源会报 "no provider"。

## 快速上手 —— 五个场景

从一个全新的 shell 开始,第一个场景应当远不到五分钟。下面的 payload 就是 MCP host
发出的 `arguments` 字面值。

### A —— Happy path:收一个 run

```jsonc
android_debug_start_session { "packageName": "com.example.app", "launchOnStart": true }
//   → { "runId": "2026-05-20T08-11-05.530Z_5X9Q", "runDir": "...", ... }
android_debug_mark_event    { "runId": "<runId>", "name": "before_repro" }
//   ... 操作 app ...
android_debug_stop_session  { "runId": "<runId>" }
android_debug_get_run_summary { "runId": "<runId>" }
//   → Markdown 报告:设备 / app / git 溯源、计数、崩溃、事件时间线
```

### B —— 崩溃:拉栈

```jsonc
android_debug_start_session { "packageName": "com.example.app", "launchOnStart": true }
//   ... 复现崩溃 ...
android_debug_extract_crash_context { "runId": "<runId>", "beforeLines": 30, "afterLines": 60 }
//   → { "crashCount": 1, "type": "java", "mainException": "...", "topFrame": "...", "snippet": "..." }
```

没有崩溃的 run 返回 `{ "crashCount": 0 }`——这不是错误。

### C —— 交互:驱动屏幕

```jsonc
android_debug_tap        { "runId": "<runId>", "x": 540, "y": 1200, "label": "Login button" }
android_debug_input_text { "runId": "<runId>", "text": "my-secret", "sensitive": true }
android_debug_send_key   { "runId": "<runId>", "key": "BACK" }
android_debug_capture    { "runId": "<runId>", "kinds": ["screenshot", "ui_dump"] }
```

`input_text` 带 `sensitive: true` 时只记一个长度占位符,绝不记原文。它还会自动
脱敏看起来像凭据的文本。

### D —— 断连:会话降级

拔掉设备(或 `adb disconnect <serial>`)。约 5 秒内健康轮询会把会话标记为
`degraded`:

```jsonc
android_debug_tap { "runId": "<runId>", "x": 1, "y": 1 }
//   → { "isError": true, "error": "device_disconnected" }
android_debug_search_logs  { "runId": "<runId>" }     // 读记录类工具仍可用
android_debug_stop_session { "runId": "<runId>" }     // 正常 finalize;summary status: "degraded"
```

### E —— 孤儿 run 恢复

如果 server 进程在会话中途被杀(`kill -9`),该 run 处于未 finalize 状态。下次
server 启动会自动恢复它:

```jsonc
android_debug_list_runs {}
//   → 被杀的那个 run 以 "status": "aborted" 出现
```

## 工作流 —— 把工具串成真实排障链路

快速上手是单个工具的演示。实际排障里 agent 会 **组合** 它们:一个工具的输出
(`runId`、marker 的 `ts`、点中的节点、一条出错的请求)喂给下一个。下面这些链路
对应常见的排障诉求。

### W1 —— "这个控件是哪段代码画的 / 点了为什么没反应?"

从屏幕上一个像素,落到拥有它的源码。

```jsonc
android_debug_list_elements    { "runId": "<id>", "filter": { "resourceIdContains": "nav" } }
//   → 把上百个 clickable 收敛到底部 nav 那几个 id(不用拉整棵树)
android_debug_tap_node         { "runId": "<id>", "x": 540, "y": 2288, "label": "tab: Dynamic" }
//   → { tappedNode, anchorNode, preTapForegroundActivity, ancestorChain }
android_debug_map_ui_node_to_source {
  "runId": "<id>",
  "anchorNode":         <tap_node.anchorNode>,
  "foregroundActivity": <tap_node.preTapForegroundActivity>,
  "ancestorChain":      <tap_node.ancestorChain>
}
//   → layout-id 声明、所属屏幕、代码引用(file:line)
```

为什么这么串:`resourceIdContains` 是便宜的选择器,不用拉全部元素就能挑中目标;
`tap_node` 一次拿到命中 + 锚点;它的结果 **直接** 喂进 `map_ui_node_to_source`,
落到真正的 XML/Kotlin。mapper 跑在「已记录的 run + 项目源码」上,finalize 过的
run 也能用。

### W2 —— "复现一个崩溃,拿到堆栈 + 现场,能转交"

```jsonc
android_debug_start_session    { "packageName": "com.example.app", "clearDeviceLogcat": true, "launchOnStart": true }
android_debug_mark_event       { "runId": "<id>", "name": "before_repro" }
//   ... 复现:tap / swipe / input_text ...
android_debug_extract_crash_context { "runId": "<id>", "beforeLines": 30, "afterLines": 60 }
//   → 异常类型、top frame、崩溃周围的原始日志片段
android_debug_search_logs      { "runId": "<id>", "afterMark": "before_repro", "level": "E" }
//   → 崩溃前的 app 侧报错
android_debug_collect_bundle   { "runId": "<id>" }
//   → 一个可塞进工单 / 发给同事的目录
```

为什么这么串:`clearDeviceLogcat` 去掉复现前的噪声;marker 锚住"从何时开始";
crash context 给堆栈、`search_logs` 给前因、`collect_bundle` 给转交物。

### W3 —— "某接口报错 / 某页面慢——定位到底是哪一次请求 + 它的上下文"

profile 驱动(Poppo/Vone 的 `poppo_http`)。需要 `projectRoot` 指向带
`.android-debug-mcp/profile.json` 的仓库。

```jsonc
android_debug_start_session    { "packageName": "com.baitu.poppo", "projectRoot": "/path/to/submodulepoppo" }
//   → profileName: "poppo-vone"  (否则 null → poppo_http 没有 provider)
android_debug_mark_event       { "runId": "<id>", "name": "symptom" }
//   ... 复现 ...
android_debug_search_evidence  { "runId": "<id>", "query": { "source": "poppo_http", "outcome": "http_error" } }
//   或:{ "source": "poppo_http", "durationMsGte": 1000, "pathPrefix": "/live" }  → 某路径上的慢请求
android_debug_extract_evidence_context {
  "runId": "<id>", "markerIsoTs": "<symptom 的 ts>",
  "sources": [ { "source": "poppo_http" }, { "source": "logcat" }, { "source": "events" } ]
}
//   → 把那次出错请求和它周围的 logcat / 导航,按 tsMs 并到一起
```

为什么这么串:`search_evidence` 用 `outcome` / `durationMsGte` / `pathPrefix`
直接从一堆请求里筛出坏的,而不是翻日志;多源时间线再把这次请求摆到「那一刻还
发生了什么」旁边。`statsRun` 里的 `bytesPulled` 告诉你这次按需拉取实际花了多少。

### W4 —— "时序 bug:把一段时间内发生的事排成一条因果线"

```jsonc
android_debug_mark_event       { "runId": "<id>", "name": "t0" }
//   ... 触发那段时序 ...
android_debug_extract_evidence_context {
  "runId": "<id>", "markerIsoTs": "<t0 的 ts>", "beforeMs": 3000, "afterMs": 8000,
  "sources": [ { "source": "poppo_nav" }, { "source": "poppo_http" },
               { "source": "events" }, { "source": "logcat", "level": "W" } ]
}
//   → nav + http + UI 事件 +(按 app pid 收敛、压缩过的)logcat,按时间并起来
android_debug_search_logs      { "runId": "<id>", "count": true, "groupBy": "tag" }
//   → 时间线被截断时,找出是哪个 tag 在刷屏
android_debug_search_logs      { "runId": "<id>", "afterMark": "t0", "tags": ["YourTag"] }
//   → 下钻到真正要看的原始行
```

为什么这么串:时间线给的是 **信号**——0.7.4 起 logcat 默认收敛到 app 自己的
pids、并丢掉 profile 声明的噪声 tag,`system_server` / `systemui` 那些 OS 噪声
不再把 app 的行淹掉。截断时 `count + groupBy` 点名刷屏者,再按需取原始行。

### W5 —— "采性能 + 跟上一个 run 对比"

```jsonc
android_debug_mark_event       { "runId": "<id>", "name": "before_scroll" }
//   ... 滚列表 ...
android_debug_perf_snapshot    { "runId": "<id>", "kinds": ["gfxinfo", "meminfo"] }
//   → 解析后的 gfxinfo(jank/帧)+ meminfo 摘要
android_debug_stop_session     { "runId": "<id>" }
android_debug_list_runs        {}
//   → 挑出上一个构建的基线 run
android_debug_get_run_summary  { "runId": "<baseline>" }
//   → 在两个 run 之间对比溯源(git sha、app 版本)+ 计数 + 性能
```

为什么这么串:快照 + marker 抓住当下;`list_runs` / `get_run_summary` 把"这次比
上个构建差吗"变成两个各自钉死 git/app 溯源的目录之间的并排对比。

## 文本输入(ADBKeyBoard)

`android_debug_input_text` 通过 **ADBKeyBoard** 辅助输入法
(<https://github.com/senzhk/ADBKeyBoard>)投递文本,这样任何输入——ASCII、中日韩、
emoji、标点——都走同一条代码路径。在设备上装一次该 APK 即可;工具会自动把它选为
当前输入法。若 ADBKeyBoard 未安装,`input_text` 返回
`{ "error": "input_method_unavailable" }`。

## 与 mobile-mcp 共存

本 server 收集 *调试证据*,并以坐标方式驱动屏幕。如果你还需要 *基于元素* 的
自动化(按无障碍树查找并点击控件),可以并排再跑一个像
[mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) 这样的工具
——在 host 的 `mcpServers` 里同时注册两者。它们互补:各管一摊,
android-debug-mcp 不碰无障碍树。

## 开发

```sh
git clone https://github.com/est7/android-debug-mcp
cd android-debug-mcp
bun install

bun run typecheck   # tsc --noEmit
bun run lint        # biome check .
bun run test        # vitest run
bun run dev         # 直接跑 stdio server
```

没有构建步骤——server 在 Bun 下直接跑 TypeScript。

真机五场景手动 checklist 见 [`docs/test-plan.md`](./docs/test-plan.md)。

## 文档

| 文件 | 用途 |
|---|---|
| [`docs/design-lock-v1.md`](./docs/design-lock-v1.md) | v1 的 17 项锁定决策 + 验收判据 + 显式 out-of-scope |
| [`docs/decision-amendments.md`](./docs/decision-amendments.md) | 锁定之外的增量与翻案(Q1/Q2 + codex audit findings) |
| [`docs/v1-implementation-plan.md`](./docs/v1-implementation-plan.md) | 分阶段实施计划 |
| [`docs/test-plan.md`](./docs/test-plan.md) | 真机五场景手动 checklist |
| [`docs/audits/`](./docs/audits/) | 各阶段 Codex audit 报告 |
| [`docs/backlog.md`](./docs/backlog.md) | v1.1 / v2 / v3 推迟项 |
