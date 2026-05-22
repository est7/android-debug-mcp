# android-debug-mcp

> English: [README.md](./README.md)

一个本地 **stdio MCP server**,用于 **Android 应用层调试取证**。它让 MCP agent
以「会话隔离、全程留痕」的方式通过 `adb` 驱动真机——拉起 app、复现 bug、操作
屏幕,并把 logcat / 崩溃 / 截图收进一个自洽的 run 目录。

它是 *证据优先* 的:每次工具调用都被记录,每个 run 都是磁盘上一个可检视、可打包、
可转交同事的目录。它刻意 **不做** 基于元素的 UI 自动化(不碰 AccessibilityService、
不按控件树点击)——见 [与 mobile-mcp 共存](#与-mobile-mcp-共存)。

状态:**v1 (0.2.0)** —— 17 个工具全部注册;五条验收场景真机通过。

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

## 17 个工具

每个工具都叫 `android_debug_*`,返回 `structuredContent`。工具 **成功** 时返回
`structuredContent`;**可恢复的失败** 则返回 `{ isError: true }`,把 JSON 形态的
`{error, message, …}` 放在 `content[0].text` 里、且 **不带** `structuredContent`
——agent 据此分支处理;它绝不会以裸协议错误的形式抛出。

| 分组 | 工具 |
|---|---|
| **会话生命周期** | `start_session`、`stop_session`、`mark_event`、`get_app_state`、`app_control`、`clear_app_data` |
| **交互** | `tap`、`input_text`、`send_key`、`swipe`、`capture` |
| **证据检索** | `search_logs`、`extract_crash_context`、`get_run_summary` |
| **设备与 run 管理** | `list_devices`、`list_runs`、`collect_bundle` |

会话按 `(deviceSerial, userId, packageName)` 三元组单例——一个 app 在一台设备上
同一时刻只有一个活跃 run。每次交互 / 证据调用都带上 `start_session` 返回的 `runId`。

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
