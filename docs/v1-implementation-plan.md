# Android Debug MCP — v1 Implementation Plan

Locked design: [`design-lock-v1.md`](./design-lock-v1.md). 增量:[`decision-amendments.md`](./decision-amendments.md)。
本计划带项目从空仓(`docs/` + `.gitignore` + `git init`)到 design-lock § "v1 验收" 5 条 scenario 全跑通。

**栈**:TypeScript + Bun ≥ 1.1、`@modelcontextprotocol/sdk` 1.x、`zod` 3.x、`vitest` 1.x、`@biomejs/biome` 1.9.x。运行时无 runtime dep beyond MCP SDK + Zod。所有路径相对 repo 根。

## 关键设计约束(实施时不得偏离)

- **Interaction = `adb shell input`**(不接 mobile-mcp,见 [`backlog.md` v2-F](./backlog.md));不走 AccessibilityService。
- **Logcat 防御四件套**(见 Phase 4 + `decision-amendments.md` § A-Q2):strict line-buffered reader、`--- N lines dropped ---` dropout 解析、多行栈归并到上一条 message、`adb logcat -G 16M` 默认 + 截断启发式。

---

## Phase 0 — 仓库骨架 + 工具链

**目标**:能跑通的 Bun + MCP server scaffold,lint / typecheck / test 全绿。

**Files**
- `package.json`(name `android-debug-mcp`,type `module`,bin `server/src/server.ts`)
- `tsconfig.json`(`strict`、`noUncheckedIndexedAccess`、`moduleResolution: bundler`、`target ES2022`)
- `biome.json`(recommended,2-space,single quote)
- `bunfig.toml`
- `server/src/server.ts`(stub `new Server({name, version}, {capabilities:{tools:{}}})` + stdio transport,空 tool list)
- `server/src/version.ts`
- `README.md`(占位,Phase 11 补全)
- `.editorconfig`

**Verify(无设备)**
```sh
bun install
bun run typecheck && bun run lint && bun test
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | bun server/src/server.ts
```
期望 MCP `initialize` 响应。

---

## Phase 1 — ADB wrapper 基础 + `list_devices`

**目标**:`adb` 唯一 chokepoint;首个 tool 端到端打通验证 SDK 接线。

**Files**
- `server/src/adb/adb.ts` — `runAdb(args, opts)` 返回 `{stdout, stderr, code}`;`spawnAdb(args, opts)` 返回流式 child handle。`ADB_PATH` env override 优先于 `which adb`。typed errors。
- `server/src/adb/devices.ts` — 解析 `adb devices -l`。
- `server/src/adb/errors.ts` — `AdbNotFoundError` / `AdbExecError` / `NoDeviceError`。
- `server/src/mcp/tools/list_devices.ts` — Zod schema + handler。
- `server/src/mcp/register.ts` — tool 注册 helper(Zod issues → MCP errors)。
- `server/src/mcp/log.ts` — stderr logger;`DEBUG=android-debug-mcp:*` gate(§ F)。
- `server/tests/adb/devices.test.ts` + fixtures `server/tests/fixtures/adb/devices-{none,one,two}.txt`。

**Delivers**:`list_devices` → `[{serial, model, apiLevel, abi, state}]`。`apiLevel` / `abi` 来自 `getprop ro.build.version.sdk` / `ro.product.cpu.abi`,懒取。

**Verify**:`bun test server/tests/adb`;真机插上后,inspector 跑 `tools/list` + `tools/call list_devices`。

---

## Phase 2 — Storage / runId / lockfile / metadata

**目标**:纯 FS 模块,run folder layout、runId 铸造、(device, package) 单例。零 tool。

**Files**
- `server/src/store/paths.ts` — `resolveRunRoot()`:`git rev-parse --show-toplevel/.android-debug-runs/` → fallback `~/.android-debug-mcp/runs/`。进程级 memoize。
- `server/src/store/runId.ts` — § F 格式(ISO + `_` + 4 char alnum)。
- `server/src/store/run.ts` — `createRunDir`(materialize `<root>/<package>/<runId>/{artifacts/}` + seed `metadata.json` 与所有空 jsonl)、`readMetadata`、`patchMetadata`、`runPath`、`runExists`。
- `server/src/store/jsonl.ts` — `AppendStream` class:单 writer,`O_APPEND` flag,`fdatasync` on flush,closed-stream write 抛错。
- `server/src/store/lock.ts` — `O_EXCL` 创建 `<root>/<package>/<deviceSerial>.lock`,内容 `{pid, runId, startedAt}`。Stale 检测:`kill(pid, 0)` + start-time 对比(防 PID 回收)。`force: true` 显式清旧。
- `server/src/store/metadata.ts` — Zod `Metadata` type + helpers(`closed_at`、`status`、`crashFound`、app/device/git 字段)。
- `server/tests/store/*.test.ts` — runId 格式、JSONL atomic append、lockfile 语义。

**Verify**:Vitest only。

---

## Phase 3 — Session manager(in-process lifecycle,无 logcat)

**目标**:`SessionManager` 编排 start/stop、timer、disconnect-degradation。打通 `start_session` / `stop_session` / `mark_event` / `get_app_state` / `app_control`。**Logcat 在 Phase 4 接入。**

**Files**
- `server/src/session/session.ts` — `Session` class:`runId` / `runPath` / `deviceSerial` / `packageName` / `pids[]` / `status: active|degraded|aborted|stopped` + event/command stream refs。
- `server/src/session/manager.ts` — `Map<runId, Session>` + `(device,package)` index;`start()` / `stop(runId?)` / `get(runId)`;接 Phase 2 lock。
- `server/src/session/timers.ts` — 硬 60min + idle 30min(§ D)。Idle 重置触发器 = interaction tool 调用。Timeout → `auto_stopped_by_timeout` 事件 + `stop()`。
- `server/src/session/health.ts`(Phase 9 完成实现)— `adb get-state` 轮询,~3s 一次。loss → `status=degraded` + `device_disconnected` 事件。
- `server/src/adb/app.ts` — 包 `pm path` / `dumpsys package <pkg>`(`versionName/Code`)/`pidof`(fallback `ps -A | grep`)/`am start`/`am force-stop`/`pm clear` / `dumpsys activity activities | head`(foreground)/`dumpsys activity exit-info <pkg>`(`exitInfo[]`)。
- `server/src/mcp/tools/start_session.ts` / `stop_session.ts` / `mark_event.ts` / `app_control.ts` / `get_app_state.ts`。
- `server/tests/session/*.test.ts` — 单例 enforcement、fake-timer 触发路径、`mark_event` payload redaction。

**Delivers**:`start_session` 写 `metadata.json`(versionName/Code/git-sha/device props);`stop_session` finalize 返回 summary stub(Phase 7 丰富)。

**Verify(真机)**
```sh
bun test server/tests/session
# 安装一个目标 app(如 com.android.settings 自带):
# inspector: start_session({packageName:"com.android.settings", launchOnStart:true})
# → mark_event → get_app_state → app_control("stop") → stop_session
ls .android-debug-runs/com.android.settings/
```

---

## Phase 4 — Logcat 双通道(含 Q2 防御四件套)⚠️ 关键路径

**目标**:`adb logcat -b main,system,crash -v threadtime *:V` 双通道。Raw byte-tee → `logcat.raw.txt`;并行 parser 输出 `logcat.jsonl`。挂到 Phase 3 `Session`。**Q2 防御点全部落地。**

**Files**
- `server/src/logcat/spawn.ts` — `startLogcat(session)`。**Spawn 前先 `adb -s <serial> logcat -G 16M`**(默认,可被 `start_session({ logcatBufferSize })` 覆盖);然后 spawn logcat child。
- `server/src/logcat/line_buffer.ts` — **strict line-buffered reader**。维护内部 buffer,只在 `\n` emit 完整行;buffer 满 64KB 没换行 → emit 一行 + `events.jsonl` 写 `{type:"abnormal_long_line", ts, length}`。**绝不**按 fixed chunk 切。
- `server/src/logcat/raw_writer.ts` — append `logcat.raw.txt`,flush 每 N=200 行 OR 1s(先到先 flush),`fdatasync` on flush。
- `server/src/logcat/parser.ts` — pure `parseThreadtimeLine(line)` → `{ts, pid, tid, level, tag, message} | null`。**处理:**
  - `--------- beginning of {main,system,crash}` 切换 marker
  - 多行栈续行(indent / `at ` 开头)→ **归并到上一条 entry 的 `message` 字段,不另起一条**
  - threadtime 变体(中间多空格、tag 含空格、Unicode message)
  - 长 message 启发式:length ≥ 4000 且 末字符 ∉ `}`/`)`/`.`/`!`/标点/换行 → `truncated_suspect: true`
- `server/src/logcat/dropout.ts` — 识别 `--- N lines dropped ---` 与 `[ Connecting ... ]` 等 logd 标记,emit `{type:"logd_dropped", count, buffer, ts}` 进 `events.jsonl`。
- `server/src/logcat/filter.ts` — `shouldKeep(entry, knownPids: Set<number>, systemTags: Set<string>)`,白名单 § F。
- `server/src/logcat/pid_tracker.ts` — 维护 `knownPids`(current + historical):
  - 周期 `pidof` 拉新 pid(主)
  - parse `am_proc_start` / `am_kill` 系统日志做实时更新(辅,有 lag 也无妨)
  - 冲突时:**poll 结果赢**(更可靠);logcat-derived 作为补强
- `server/src/logcat/worker.ts` — 串接 line_buffer → parser → dropout → filter → JSONL appender;调 Phase 5 `redact` 模块对 message 做 redaction。
- `server/src/logcat/recovery.ts` — `replayParse(rawPath, outPath)`:从已存在 raw 重建 `logcat.jsonl`(Phase 8 用)。
- `server/src/logcat/crash_marker.ts` — 与 parser 并行扫崩溃 signature(§ F),写 `crash.jsonl` 含 `{rawLineOffset, ts, type, marker}`,offset 是 `logcat.raw.txt` 内的**行号**(不是 byte;raw 是 append-only,行号稳定且不依赖编码)。
- `server/tests/logcat/parser.test.ts` — 驱动 ≥5 fixtures(Phase 12 系统化收集)。
- `server/tests/logcat/{filter,dropout,crash_marker,line_buffer}.test.ts`。

**Delivers**
- 真机 `start_session` → `logcat.raw.txt` + `logcat.jsonl` 同步增长
- `stop_session` 优雅终止 adb child、flush 两 writer、等 parser drain
- adb child 异常退出 → `logcat_terminated_unexpectedly` 事件
- 长行不被切碎、栈不被打散、buffer overflow 有 marker

**Verify**
```sh
bun test server/tests/logcat
# 真机:
# start_session → 同时 tail -f raw 与 jsonl
# 跑一个高频 log 的 app + 旁边 terminal `adb logcat -c` → MCP 不崩;raw 已 flush 部分不丢
```

---

## Phase 5 — Redaction matcher

**目标**:纯模块,scrub event payload / command line / 可选 logcat。

**Files**
- `server/src/redact/redact.ts` — `redactValue` / `redactObject`。Regex set:§ baked-in #4 + `input_text` 启发式(§ F)。
- `server/tests/redact/*.test.ts` — 20+ table case,含 `input_text` length-preserving placeholder(`***<len>`)。

**Verify**:Vitest only。**可与 Phase 4 并行。**

---

## Phase 6 — Interaction tools + capture

**目标**:`tap` / `input_text` / `send_key` / `swipe` / `capture` 接 session。**走 `adb shell input *` 与 `adb exec-out screencap` / `uiautomator dump`,不用 AccessibilityService。**

**Files**
- `server/src/adb/input.ts` — `inputTap` / `inputText`(转义 + sensitive 脱敏)/ `keyevent`(白名单 enforced)/ `inputSwipe`。
- `server/src/adb/capture.ts` — `adb exec-out screencap -p` → `artifacts/screenshot-<ts>.png`;`uiautomator dump` + `adb pull` → `artifacts/ui-<ts>.xml`。
- `server/src/ui/summary.ts` — UI XML pure parser(top activity + `clickable=true` 节点数)。**优先用 50 行 regex,无 dep**;若发现 XML 复杂度高再引入 `linkedom`。
- `server/src/mcp/tools/{tap,input_text,send_key,swipe,capture}.ts`。
- 五个 tool 共享 `assertActiveSession(runId)` + `assertDeviceConnected(session)` helper;每次调用 append `commands.jsonl`(post-redaction adb literal)+ `events.jsonl`(语义事件)。
- `server/tests/ui/summary.test.ts` + `server/tests/fixtures/ui/*.xml`(2 份真机 dump)。

**Delivers**:Scenario C 端到端可跑。**可与 Phase 4 并行(在 Phase 3 完成后启动)。**

**Verify(真机)**
```sh
# inspector:
tap({runId, x:500, y:1000, label:"Login button"})
input_text({runId, text:"my-password-123", sensitive:true})
send_key({runId, key:"BACK"})
capture({runId, kinds:["screenshot","ui_dump"]})
cat .android-debug-runs/.../events.jsonl
ls .android-debug-runs/.../artifacts/
```

---

## Phase 7 — Evidence retrieval + summary

**目标**:`search_logs` / `extract_crash_context` / `get_run_summary`。

**Files**
- `server/src/search/search_logs.ts` — 流式读 `logcat.jsonl`(不全量加载),filter `query` / `level` / `sinceTs` / `beforeMark`/`afterMark`(mark 走 `events.jsonl` 扫描)。Empty query → recent N。`query` **默认 substring**(避免 regex DoS);v1.1 可加 `regex: true` opt-in(列入 open decisions)。
- `server/src/search/crash_context.ts` — 读 `crash.jsonl` markers,定位 raw 行号 → ±N 行抽取 → 解析 `mainException` / `topFrame`。
- `server/src/summary/render.ts` — pure markdown 渲染:device + app + git + 事件 timeline + crash 高亮 + counts。
- `server/src/summary/finalize.ts` — `stop_session` 与 Phase 8 orphan 都调:写 `summary.md` + 关闭 `metadata.json`。
- `server/src/mcp/tools/{search_logs,extract_crash_context,get_run_summary}.ts`。
- `server/tests/search/*.test.ts` — fixture-based,含 before/after mark resolution。

**Delivers**:Scenario A、B 可跑。

---

## Phase 8 — Orphan recovery + run management

**目标**:启动时恢复 `closed_at == null` 的 run;`list_runs`;bundle 导出。

**Files**
- `server/src/recovery/scan.ts` — MCP boot 时扫 `<root>/*/*/metadata.json` 找 orphan。逐个:Phase 4 `recovery.replayParse` 重建尾部 jsonl + Phase 7 `finalize`,`status: aborted`。**在 server `start_session` 接客前完成。**
- `server/src/mcp/tools/list_runs.ts` — 目录扫 + metadata 读;按 `startedAt` desc;默认 limit 20。
- `server/src/bundle/bundle.ts` — `tar -czf bundle-<runId>.tar.gz` 输出(spawn `tar`,macOS/Linux 自带)。`includeRaw=false` 时不含 `logcat.raw.txt`(§ F 默认)。
- `server/src/mcp/tools/collect_bundle.ts`。
- `server/src/bootstrap.ts` — server.ts listen 前调 `recovery.scan` + 注册所有 tool。

**Delivers**:Scenario E 可跑。

**Verify**
```sh
# active session 时:
kill -9 <mcp-pid>
bun server/src/server.ts
# list_runs → 看到 status:aborted
# get_run_summary({runId}) → partial markdown
```

---

## Phase 9 — Disconnect path 收尾

**目标**:Phase 3 `health.ts` 实装。Device-touching tool 在 degraded 时 reject;read tool 仍可用。

**Files**
- `server/src/session/health.ts` — finalize(Phase 3 桩)。
- 触点 audit:`tap` / `input_text` / `send_key` / `swipe` / `capture` / `app_control` 头部调 `assertDeviceConnected(session)`,degraded 时返回 `{error:"device_disconnected"}`。
- `server/tests/session/disconnect.test.ts` — mock adb `state=offline`。

**Delivers**:Scenario D 可跑。

---

## Phase 10 — Hardening 一轮

**目标**:边界 + error shape 一致化。

**Files**
- `server/src/mcp/errors.ts` — 错误目录:`run_missing` / `no_active_session` / `device_disconnected` / `singleton_violation` / `adb_not_found` / `run_finalize_failed` / `parser_error`。
- 每个 tool handler audit。
- `server/tests/integration/*.test.ts` — table tests,内存 FS / tmp dir + mock adb。

---

## Phase 11 — README + quickstart

**目标**:fresh shell 到第一个 scenario < 5 分钟。

**Files**
- `README.md` — install(Bun ≥ 1.1、system adb)、Claude Code / Cursor `mcp.json` 片段(`command: bun`、`args: ["/abs/path/server/src/server.ts"]`)、5 scenario quickstart 含真实 tool-call payload。**写明"如需 element-based 自动化,可并列接 mobile-next/mobile-mcp,两者各管一摊"。**
- `docs/test-plan.md` — 5 scenario manual checklist。

---

## Phase 12 — Fixture harvest + Vitest gate

**目标**:logcat fixture ≥5,redaction golden output,最后回归测试。

**Files**
- `server/tests/fixtures/logcat/{normal,multiline-stack,crash-java,crash-native,anr,truncated,dropped}.txt` — 7 份(原计划 5,Q2 增加 `truncated` 与 `dropped` 两类)。
- `server/tests/fixtures/redact/{events,commands,input-text}.json` — golden。
- 本地 CI 等价:`bun run lint && bun run typecheck && bun test` 必绿。

---

## 并行计划

两条 stream:

- **Stream X(关键路径)**:0 → 1 → 2 → 3 → 4 → 7 → 8 → 9 → 10 → 12
- **Stream Y(可并)**:Phase 5(redaction)与 3/4 并行;Phase 6(interaction)在 3 完成后与 4 并行;Phase 11(README)在 7 functional 后启动

明确安全的并行对:
- Phase 4 ‖ Phase 5
- Phase 6 ‖ Phase 4(Phase 3 之后)
- Phase 11 ‖ Phase 9/10

Phase 8(recovery)**必须**在 4 + 7 之后(复用 parser replay + summary finalize)。

---

## 关键路径风险

**确认:Phase 4 是 v1 单一最高风险。**

1. **Parser robustness**:`-v threadtime` 看起来规整,真机有 `--------- beginning of` 头、多行栈缩进续行、tag 含空格、events buffer 误入 binary 漂、Unicode message、跨 buffer 边界的 UTF-8 半截。每个没见过的 fixture 都会暴一个 bug。
2. **Concurrent stream lifecycle**:adb child stdout → raw writer flush loop → parser worker → JSONL writer flush loop,四个并发对象在 `stop_session` / adb 中途崩 / 父 MCP `kill -9` 三种 shutdown 路径上要正确 drain。Bun `Bun.spawn().stdout` 是 async iterable,**partial-line 在 chunk 边界**是经典坑——line_buffer.ts 必须严格行缓冲。

次级风险:
- Phase 8 orphan recovery 复用 4 的 replay 模式,bug **静默**(summary 看着对其实错),不易发现 → 必须有 fixture 测试。
- Phase 2 lockfile stale + PID 回收 → `O_EXCL` + start-time check 双保险。
- Phase 6 `uiautomator dump` 在 Android 14 某些设备返回 `ERROR: null root node returned` → 单次重试 + 失败明确返回 `{uiSummary: null, uiDumpPath: null}`,不抛错。

预算建议:Phase 4 ~30% 总工时;Phase 8 ~10%;其余均分。

---

## Open implementation decisions(每个 phase 开启前问)

design-lock 未决,plan 也不擅自决定。开始相关 phase 前回我:

1. **Phase 3 — `start_session` 同步性**:返回时机是"已 spawn logcat 但未确认 attach" / "等到 logcat 输出第一行才返回"?后者更稳但增加几百 ms。
2. **Phase 2 — Lockfile 位置**:`<root>/<package>/<serial>.lock`(repo-local 跟 run 同寿)还是 `~/.android-debug-mcp/locks/`(全局)?倾向前者。
3. **Phase 4 — Parser pipeline 形态**:in-process async iterator vs `new Worker(URL)`。默认 in-process;若 logcat 洪水触发 GC 压力再换 Worker。
4. **Phase 4 — pid_tracker 冲突仲裁**:poll vs logcat-derived 都给了答案不一致时谁赢?**默认 poll 赢**,logcat-derived 作为补强用于反应速度。
5. **Phase 4 — crash offset 存储**:byte offset(快但脆)vs (line_no, ts)(稳)?**默认 line_no,raw append-only 保证稳定**。
6. **Phase 5 — Redaction 是否覆盖 `logcat.jsonl`**:§ baked-in #4 只写 events + commands。v1 暂**不**覆盖 logcat;v2-E upload 启动时再加(已在 backlog)。
7. **Phase 6 — UI XML 解析选型**:regex(零 dep)vs `linkedom`(1 dep)?**默认 regex**;若 v1.1 发现误判率 > 10% 再换。
8. **Phase 6 — Sensitive 启发式优先级**:`sensitive:false` 显式传 vs 启发式 regex 命中。**默认启发式赢**(更保险),agent 想绕过必须 `sensitive: false` + 用 `tap+input` 拆分文字。
9. **Phase 7 — search_logs query 语义**:substring 默认 / regex opt-in?**默认 substring**,`regex: true` 作为 future flag 不进 v1。
10. **Phase 8 — Bundle 格式**:`tar.gz`(macOS/Linux 自带)vs `zip`(需 spawn `zip`)?**默认 tar.gz**。
11. **Phase 3 — `clearLocalRunLogs` 语义**:删此 package 所有历史 run / 仅清此次(no-op,新 run 本来就空)?**默认前者**:`rm -rf <root>/<package>/` 清理 package 维度的旧 run,留其他 package 不动。
12. **Phase 3 — `launchOnStart` 失败时**:start_session 整体回滚 / 成功返回 `pid: undefined` 让用户后续 `app_control` 拉?**默认后者**(更宽容);失败原因记 events.jsonl。
13. **Phase 10 — MCP error transport**:`McpError`(SDK)vs `{content:[{type:"text", text: JSON.stringify({error})}]}` 工具结果。**默认后者**(agent 易于 branch);protocol-level 错才用 `McpError`。

---

### 关键文件清单(实施时优先 review)

- `server/src/logcat/parser.ts`
- `server/src/logcat/line_buffer.ts`(Q2 新增)
- `server/src/logcat/spawn.ts`
- `server/src/session/manager.ts`
- `server/src/store/run.ts`
- `server/src/recovery/scan.ts`
