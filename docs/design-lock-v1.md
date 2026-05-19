# Android Debug MCP — v1 Design Lock

Locked: 2026-05-19. Derived from grilling session in this repo's conversation history. Source material: [`../suggestion-chat.md`](../suggestion-chat.md).

## 项目身份

一个本地 stdio MCP server,服务 Android 应用层 debug 证据采集。
**Session 中心、tools-only、与现有 android-debug-tools plugin 并存不共享代码、TypeScript + Bun 实现。**

## Baked-in assumptions(不上桌的前提)

1. 应用层 debug;不做 perf / ANR 深挖。
2. v1 单设备(多设备并发留 v2)。
3. Transport: stdio only(Streamable HTTP 留 v2)。
4. 敏感数据默认 redact:`Authorization` / `Cookie` / `token` / `password` / `otp` / `verification` 命中即脱敏(events.jsonl 与 commands.jsonl 都脱)。

## 17 项决策

### A. 架构与范围

| # | 决策 | 选定 |
|---|---|---|
| 1 | 核心抽象层级 | **B · Debug Session 中心**(run folder + PID timeline + 双通道 logcat + crash 提取 + bundle) |
| 2 | 与 android-debug-tools plugin 关系 | **并存,MCP 自己 spawn adb**;plugin 仅作启发,后续删除,不复用任何代码 |
| 3 | 技术栈 | **TypeScript + Bun + 官方 MCP SDK + Zod**;JSONL append-only 存储 |
| 4 | 目标应用范围 | **自有 repos 优先**(Poppo / Vone / popposhell);第三方 app 自动 fallback 到 ADB-only |
| 5 | Agent 交互模式 | **两种模式无主推,session-aware**;人工为默认,自动化能力前瞻 |
| 6 | Tool 粒度 | **少而高级**,16 个 session-oriented tools,无 `adb_shell(cmd)` 类 escape hatch |
| 7 | v1 source mapping | **不做**,留 v2(见 [`backlog.md`](./backlog.md)) |
| 8 | v1 app-side sidekick | **不做**,留 v3(见 [`backlog.md`](./backlog.md)) |

### B. Session 模型

| # | 决策 | 选定 |
|---|---|---|
| 9 | Session 作用域 | **(device, package) 单例**;第二次 `start_session` 同 tuple 时 reject + 提示 `force: true` 或先 stop |
| 10 | Run 落盘位置 | `<git-toplevel>/.android-debug-runs/<package>/<ISO-ts>_<4charId>/`;无 git → `~/.android-debug-mcp/runs/` |
| 11 | Logcat 采集 | **双通道**:`logcat.raw.txt`(`adb logcat -b main,system,crash -v threadtime *:V`)+ `logcat.jsonl`(filtered: app pid + 系统关键 tag + severity≥W);写 raw 不预过滤,parser worker 增量产 jsonl |
| 12 | MCP 表面 | **Tools-only**(无 resources);所有读写都是 tool call,带 runId |
| 13 | Interaction 与 session 关系 | **session-aware**;每次 tap/swipe/key/input/capture 必须带 runId,自动 append `commands.jsonl` + `events.jsonl`;无 active session 时 reject |

### C. Tool 清单(16 个)

```
A. Lifecycle (3)
   1.  list_devices                      ()
                                         → [{serial, model, apiLevel, abi, state}]

   2.  start_session                     { packageName, deviceSerial?,
                                           clearLocalRunLogs?, clearDeviceLogcat?,
                                           launchOnStart? }
                                         → { runId, runPath, pid? }

   3.  stop_session                      { runId? }
                                         → { summary, runPath, crashFound }


B. Session-time recording (3)
   4.  mark_event                        { runId, name, payload? }
                                         → { ts }

   5.  app_control                       { runId,
                                           action: "launch"|"restart"|"stop"|"clear-data" }
                                         → { pid? }

   6.  get_app_state                     { runId }
                                         → { activity, foreground, pids[],
                                             versionName, versionCode, abi,
                                             exitInfo[] }


C. Interaction (session-aware, 4)
   7.  tap                               { runId, x, y, label? }
   8.  input_text                        { runId, text, sensitive? }
   9.  send_key                          { runId, key }    // 白名单:BACK/HOME/ENTER/DEL/TAB/MENU/VOL+/VOL-
   10. swipe                             { runId, x1, y1, x2, y2, durationMs? }


D. Capture (merged, 1)
   11. capture                           { runId,
                                           kinds: ("screenshot"|"ui_dump")[],
                                           label? }
                                         → { screenshotPath?, uiDumpPath?, uiSummary? }


E. Evidence retrieval (3)
   12. search_logs                       { runId, query?, limit?, level?,
                                           sinceTs?, beforeMark?, afterMark? }
                                         → entries[]
                                         // query 空 → 退化为 recent N

   13. extract_crash_context             { runId, beforeLines?, afterLines? }
                                         → { found, type, mainException, topFrame,
                                             snippet }
                                         // 默认 ±200 行;扫 FATAL EXCEPTION /
                                         // Caused by / signal 11 / SIGSEGV / ANR in

   14. get_run_summary                   { runId }
                                         → { markdown, meta }


F. Run management (2)
   15. list_runs                         { packageName?, limit? }
                                         → [{ runId, packageName, startedAt,
                                              durationMs, crashFound, status }]

   16. collect_bundle                    { runId, includeRaw? }
                                         → { bundlePath }
                                         // includeRaw 默认 false
```

### D. 健壮性

| 项 | 选定 |
|---|---|
| MCP crash 后 orphan run | **自动 finalize**:下次启动扫 `metadata.closed_at` 缺失的 run,补跑 parser 产 jsonl + partial summary,标 `status: aborted` |
| Session 时长 | **硬上限 60min + idle 30min**(任一触发 auto-stop,events 写 `auto_stopped_by_timeout`) |
| 设备断连 | **degraded state**;read tools 仍可工作,device-touching tools reject,不允许接续(重连后必须 stop+start 新 session) |
| 用户另开 terminal 跑 `adb logcat` | 完全允许(concurrent-readable),MCP 不感知 |
| 用户另开 terminal 跑 `adb logcat -c` | 无法防御;已 flush 的 raw 不丢;events 不写特殊事件 |
| 用户 `adb kill-server` | 等价于设备断连 |
| Run 目录被外部 `rm -rf` | 后续对该 runId 的 read tool 返回 `{ error: "run_missing" }`,不 crash |
| 旧 run 体积膨胀 | v1 不做自动清理;`list_runs` 默认显示最近 20 条;手动 `rm -rf` 是用户责任 |

### E. 分发与结构

| # | 决策 | 选定 |
|---|---|---|
| 16 | 分发模式 | **v1: bun-from-source**(`bun /path/to/server.ts` stdio);v1.1: `bun build --compile` 单二进制;不打包 adb,要求系统已装 |
| 17 | 仓库结构与命名 | 单 repo `git init` 在 `android-debug-mcp/`;包名 `android-debug-mcp`;backlog → `docs/backlog.md` |

### F. 默认值表(已替你定,可在实施中翻案)

| 项 | 默认 |
|---|---|
| Logcat buffers | `main, system, crash`(不含 radio / events) |
| Logcat verbosity | `*:V`(verbose,所有 priority 都进 raw) |
| Logcat format | `-v threadtime` |
| Channel B 过滤白名单 | 当前 + 历史 app PID 的全部条目;系统 tag `AndroidRuntime` / `ActivityManager` / `WindowManager` / `System.err` / `libc` / `DEBUG`;其他 entries severity ≥ `W` |
| Logcat flush 节奏 | 每 N 行或每 1s,先到先 flush |
| `adb logcat -c` | 默认不跑;`start_session({ clearDeviceLogcat: true })` 显式 opt-in |
| `runId` 格式 | ISO8601(`:` 替换为 `-`) + `_` + 4 字符 random alnum |
| `commands.jsonl` 内容 | 真实 adb 命令字面量 + tool args(用于回放;sensitive 字段已脱) |
| `events.jsonl` 内容 | 语义事件 `{ type, ts, ...payload }`(`tap` / `input_text` / `send_key` / `swipe` / `mark` / `capture` / `lifecycle` / `device_disconnected` / `logcat_terminated_unexpectedly` / `auto_stopped_by_timeout`) |
| Screenshot 返回形态 | 落地 `artifacts/screenshot-{ts}.png`,只返回 path(不返回 base64,避免 token 爆) |
| UI dump 返回形态 | 落地 `artifacts/ui-{ts}.xml`,返回 path + trimmed summary(top activity + clickable nodes count) |
| `input_text` 脱敏触发 | 启发式:text 命中正则 `(?i)password\|token\|otp\|verification` 时 events 与 commands 都用 `***` + length 占位 |
| `send_key` 禁用 | `KEYCODE_SLEEP` / `KEYCODE_POWER` 等容易把设备搞 awkward 的 |
| `crash signature markers` | Java: `FATAL EXCEPTION` / `Caused by:` / `AndroidRuntime`;Native: `signal 11 (SIGSEGV)` / `signal 6 (SIGABRT)` / `*** *** ***`;ANR: `ANR in ` / `Reason:`(标 `type: anr`,不视作 crash 但记录) |
| Bundle 内容(default) | summary.md / metadata.json / events.jsonl / commands.jsonl / crash.jsonl / app-state.json / artifacts/ 整目录 / logcat.jsonl;不含 logcat.raw.txt |
| Bundle 内容(includeRaw=true) | 上面 + logcat.raw.txt |
| MCP server 自身日志 | stderr(stdio MCP 不能用 stdout);warn/error 直接落 stderr,debug 走 `DEBUG=android-debug-mcp:*` 环境变量门控 |

## v1 验收(全部 5 条 scenario 跑通即 done)

| 编号 | 场景 | 通过判据 |
|---|---|---|
| A | Happy path | `start_session` → 30s 手动操作 → `stop_session`;返回的 summary 含 versionName / versionCode / activity / git sha;`crashFound: false` |
| B | Crash path | 手动触发已知 Java crash;`extract_crash_context` 返回结构化 `{ mainException, topFrame, snippet }`;snippet 含 FATAL 前后 ±200 行 |
| C | Interaction path | `tap` + `input_text(sensitive)` + `send_key("BACK")` + `capture(kinds:[screenshot,ui_dump])`;`events.jsonl` 每步一行;sensitive text 脱敏;`artifacts/` 有 png + xml |
| D | Disconnect path | 拔 USB(或 `adb kill-server`)→ `tap` 返回 `device_disconnected` error;`stop_session` 正常 finalize;summary `status: degraded` |
| E | Orphan path | `kill -9` MCP → 重启 MCP;`list_runs` 显示该 run `status: aborted`;`get_run_summary` 返回 partial markdown |

## v1 交付物清单

- `server/src/` 全部源码(MCP server + parser + storage + adb wrapper)
- `server/tests/` Vitest unit(parser、crash matcher、redaction matcher);fixture 至少 5 份真机 logcat 样本
- 项目根 `README.md`:install + Claude Code / Cursor `mcp.json` 配置 + 5 个 scenario 各一段 quickstart
- `docs/backlog.md`:v1.1 / v2 / v3 deferred items
- **不在 v1**: `docs/architecture.md` / CI emulator-based integration test / `bun build --compile` 二进制 release

## 测试策略

| 项 | 决策 |
|---|---|
| 框架 | Vitest |
| Unit 必覆盖 | logcat parser、crash signature matcher、filter rule eval、redaction matcher |
| Parser fixture | `tests/fixtures/logcat/*.txt`,真机 dump 出来的脏数据样本至少 5 份 |
| Integration | 手动跑 5 个 scenario,`docs/test-plan.md` 写 checklist(v1.1 看情况补 emulator-based CI) |
| Lint / Format | Biome;`bun run lint` 必须过 |
| TypeScript strict | `tsconfig.json` 开 `"strict": true`、`"noUncheckedIndexedAccess": true` |

## 显式 out-of-scope(防止实现时漂)

实现 v1 时,如果出现做以下事情的冲动,**停**——它们已被显式裁出 v1。要做的话先翻 `backlog.md`,触发条件成立才开新增 decision。

- 任何 `android_shell(cmd)` 类 escape hatch tool
- Source mapping(resourceId / testTag → 文件)
- App-side sidekick(debugImplementation 模块)
- Perfetto / simpleperf / heap dump / 帧 jank / ANR 深挖
- 自动 UI 复现(`agent_replay_steps` 类 high-level)
- 自动清理旧 run(TTL / quota)
- Windows 官方支持
- 多设备并发 session
- Streamable HTTP transport
- npm publish

## 实施时现场判断的细节(不再 grill)

命名风格(snake_case tool / camelCase TS field)、Zod schema 拆分粒度、目录细分(`src/adb/` / `src/logcat/` / `src/mcp/` / `src/store/`)、Biome 配置、Bun 版本下限、logcat parser 实现选型(自写 vs 现成库)、tsconfig 严格项细枝末节、`metadata.json` 字段命名细节。这些遇到再说,grill 它们 ROI 太低。

## 翻案规则

若在 v1 实施中发现某项决策需要翻案:

1. 不要就地改本文件。
2. 新增 `docs/decision-amendments.md` 一段,记录:原决策编号、原选定、新选定、触发原因、影响范围。
3. 同步更新 `docs/README.md` 索引。
4. v1 结束后,把 amendments 合并进 `design-lock-v2.md`(如有 v2)。

这条规则保证设计 lock 是真"lock",而不是边做边改的活文档。
