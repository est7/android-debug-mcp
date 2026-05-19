# Decision Amendments

Lock 之外的增量与翻案。规则见 [`design-lock-v1.md` § 翻案规则](./design-lock-v1.md#翻案规则)。
增量(不否定原决策、只是补强)用 ➕;翻案(改动原决策)用 ♻️。

---

## A · Logcat 防御四件套(Q2 增量)

- **日期**:2026-05-19
- **类型**:➕ 增量
- **触发**:用户在 Plan 阶段提出"代码侧 logcat 输出有截断风险,如何在 jsonl append 时防御"
- **影响范围**:design-lock § B-11(logcat 采集)、§ F(默认值表);[`v1-implementation-plan.md` Phase 4](./v1-implementation-plan.md#phase-4--logcat-双通道含-q2-防御四件套--关键路径)
- **与原决策的关系**:**不否定**双通道架构,仅在采集义务上加四条强制项

### 四项义务(implementer 不得偷工)

1. **Strict line-buffered reader**(`server/src/logcat/line_buffer.ts`)  
   不按 byte chunk 切;内部 buffer 仅在 `\n` emit 完整行。Buffer 满 64KB 仍无换行 → 强制 emit + `events.jsonl` 写 `abnormal_long_line`。防御点:Bun.spawn stdout 的 partial-line 跨 chunk 边界。

2. **`--- N lines dropped ---` dropout 标记解析**(`server/src/logcat/dropout.ts`)  
   logd buffer 溢出时设备会写 dropout marker,parser 必须识别并往 `events.jsonl` 写 `{type:"logd_dropped", count, buffer, ts}`,agent 能看到"这里有缺口"。

3. **多行栈续行归并**(`server/src/logcat/parser.ts`)  
   Java 栈的 `at com.foo.Bar(Bar.kt:42)` 缩进续行**归并到上一条 entry 的 `message`**,不另起一条 jsonl row。否则 `extract_crash_context` 拿不到完整堆栈。

4. **`adb logcat -G 16M` 默认 + 截断启发式**  
   `start_session` spawn logcat 前先 `adb -s <serial> logcat -G 16M`(降低 buffer 溢出概率)。可被 `start_session({ logcatBufferSize: "32M" })` 覆盖。Parser 检测 message length ≥ 4000 且末字符不像"正常结尾" → 标 `truncated_suspect: true`,agent 看到这个 flag 知道证据可能被 Android logd 在 app 端截断了。

### § F 默认值表增量(替换/新增)

| 项 | 新默认 |
|---|---|
| Logcat buffer size | `adb logcat -G 16M`(每次 start_session 设置,不还原) |
| `start_session` 入参 | 新增 `logcatBufferSize?: string`(default `"16M"`) |
| Parser line buffer 上限 | 64KB,超过 emit `abnormal_long_line` |
| 多行栈归并 | 缩进续行归到上一 entry `message` 字段 |
| Dropout marker | parser 识别 + 写 `{type:"logd_dropped"}` 到 events.jsonl |
| 截断启发式 | message length ≥ 4000 且尾字符不在 `}|)|.|!|?|换行|标点` → `truncated_suspect: true` |

### 不在本增量中(限定范围,防漂)

- **App 端日志截断本身**(Android logd 4076 字符限制)无法在 MCP 端还原,只能标记 + 建议。完整解法走 [`backlog.md` v3-D · App 端日志诊断回路](./backlog.md#v3-d--app-端日志诊断回路)。
- **Logcat.jsonl 的 redaction 覆盖**未在此增量中,见 plan open decision #6 + backlog v2-E。

---

## B · Interaction 实现路径明确(Q1 澄清)

- **日期**:2026-05-19
- **类型**:➕ 澄清(非翻案)
- **触发**:用户问"是否接入 mobile-next/mobile-mcp"
- **影响范围**:design-lock § C(tool 清单 7-10)、§ F;[`v1-implementation-plan.md` Phase 6](./v1-implementation-plan.md#phase-6--interaction-tools--capture)
- **与原决策的关系**:**不修改**原决策(session-aware interaction tools 仍由我们实现),仅明确技术路径

### 明确事项

1. v1 的 `tap` / `swipe` / `send_key` / `input_text` 走 **`adb shell input *` 内置命令**,不走 AccessibilityService、不依赖 app 内 helper、不接入外部 MCP。
2. `mobile-next/mobile-mcp` 作为**未来 element-based 自动化**的候选评估方案,移到 [`backlog.md` v2-F](./backlog.md#v2-f--element-based-interaction-mobile-mcp-评估)。
3. v1 README 在配置示例处**显式建议**:用户若需 element-based 自动化能力,在同一 agent host 里**并列**配 mobile-mcp,两者各管一摊(我们管 session + 证据,mobile-mcp 管语义级 UI 驱动)。

### 不在本明确中

- 是否在 v2 把 mobile-mcp **嵌入**我们的 server(vs 仅并列):留 backlog v2-F 评估;评估时必须解决"嵌入后如何让 mobile-mcp 的操作进入我们的 events.jsonl"。

---

## C · Codex audit critical findings(2026-05-19)

- **日期**:2026-05-19
- **类型**:♻️ 翻案(部分)+ ➕ 增量(部分)
- **触发**:codex audit 见 [`audit-2026-05-19-codex.md`](./audit-2026-05-19-codex.md)
- **影响范围**:design-lock § B-9 / § B-10 / § B-11 / § F、v1-implementation-plan Phase 2 / 4 / 8
- **共识**:5 个 critical 全收

### C-1 · Raw 通道字节级 tee,parser 不可污染事实源

- **原 plan**:Phase 4 一条 pipeline,`stdout → line_buffer → parser → 同时写 raw 与 jsonl`
- **新 plan**:`stdout(Uint8Array)` 同时 tee 两路 → (a) raw_writer 直接 byte-for-byte 写 `logcat.raw.txt`(零解码) + (b) `TextDecoder({fatal:false})` 流式 → line_buffer → parser → `logcat.jsonl`
- **`logcat.jsonl` 每行新增**:`rawLineNo`(对应 raw 文件第 N 行,1-based)+ `rawByteCount`(累计字节数,定位偏移用)
- **影响 Phase 4 文件**:`raw_writer.ts` 改为接 `Uint8Array` 而非 `string`;`line_buffer.ts` 改为消费独立 TextDecoder 流

### C-2 · Logcat filter 改为 UID-based(配合 C-2+M8 三元组)

- **原 lock**:Channel B 白名单 = app PID + 系统关键 tag + severity≥W
- **新规则**:`uid == appUid OR pid in knownPids OR tag in criticalSystemTags`
- **取 UID 来源**:`dumpsys package <pkg> | grep userId=`(通用,API 21+);**不**用 `cmd package resolve-activity`(API < 30 兼容性差)
- **`processName` 用法**:从 enrichment 字段填充(`logcat -v threadtime` 不带,parser 通过 `am_proc_start` 系统日志获取后回填);**不**作为过滤前提
- **影响**:Phase 1 `adb/app.ts` 增 `getAppUid(serial, pkg, userId)`;Phase 4 `filter.ts` 改条件;Phase 4 `pid_tracker.ts` 重命名为 `process_tracker.ts`,维护 `{appUid, knownPids, knownProcessNames}`

### C-3 · Run root 解析新增 explicit projectRoot + env var(配合 M10)

- **原 lock § B-10**:`git rev-parse --show-toplevel/.android-debug-runs/`,无 git → `~/.android-debug-mcp/runs/`
- **致命问题**:MCP server 的 `process.cwd()` 在 Claude Desktop / Cursor stdio 启动时通常是 host config 目录或 `/`,**不是**用户的 Android repo
- **新解析顺序**:
  1. `start_session` 入参 `projectRoot?: string`(显式优先)
  2. `ANDROID_DEBUG_MCP_RUN_ROOT` 环境变量(host config 注入)
  3. MCP server `process.cwd()` 上跑 `git rev-parse --show-toplevel`(仅当显式表明走 cwd 路径,如 inspector 本地调试)
  4. 兜底:`~/.android-debug-mcp/runs/`
- **新 metadata 字段**:`runRoot: string` + `runRootSource: "explicit"|"env"|"cwd-git"|"fallback"`
- **Tool schema 影响**:`start_session` 新增 `projectRoot?: string`;`list_runs` 返回结果新增 `runRoot`
- **README**:必须显式建议在 `mcp.json` 里 set `ANDROID_DEBUG_MCP_RUN_ROOT` env 指向具体 Android repo

### C-4 · 默认 bundle 不携带未脱敏 logcat

- **原 § F**:默认 bundle 含 `logcat.jsonl`(未脱敏),`includeRaw=true` 再加 raw
- **新 schema**:`collect_bundle({ runId, logs?: "none"|"redacted"|"raw" })`,**default `"none"`**
- **`"redacted"` 行为**:v1 内置 `redactLogcatJsonl(input, output)`(walk 每行 `message` 字段过 baked-in #4 regex + Authorization/Cookie line-pattern),写临时 `logcat.redacted.jsonl` 进 bundle 后立即删
- **`"raw"` 行为**:加 `logcat.jsonl` + `logcat.raw.txt`(都未脱敏),**要求**调用方在入参里同时传 `acknowledgeUnredacted: true`,否则 reject
- **backlog 影响**:v2-E bundle 上传仍需 secondary scan;但 v1 已堵住"默认 bundle 泄漏"这条最大漏洞

### C-5 · Orphan recovery 强制 lock owner 校验

- **原 plan Phase 8**:扫 `metadata.closed_at == null` → 自动 finalize
- **漏洞**:lock 残留但 pid 仍 alive 时双 finalize 竞态
- **新决策树**:
  1. 扫 `closed_at == null` 的 metadata
  2. 对每个,读对应 `<deviceSerial>.<userId>.<package>.lock`(配合 M8 三元组)
  3. Lock 存在 + pid alive + start-time match → 标 `recover_blocked_active_owner`,**不** finalize,并拒绝同 tuple 的 `start_session`
  4. Lock 存在但 pid stale(`kill(pid,0)` 失败或 start-time 不 match)→ replay parse + finalize + 原子删 lock
  5. Lock 不存在 → 视为 finalize 失败的孤儿,直接 finalize + status=aborted
- **顺序**(配合 M13):同 tuple 串行,按 `started_at` 升序;跨 tuple 可并发

---

## D · Codex audit major findings(2026-05-19)

8 条 major 全收,1 条加我方推翻(M11 中 destructive 调用加二次确认):

### D-M1 · Shutdown 顺序

`stop_session` / 设备断连 / parent kill 三种 shutdown 路径统一:

```
SIGTERM adb child
  → wait min(proc.exited, reader EOF) with 3s deadline
  → drain remaining stdout chunks
  → close raw_writer + jsonl_writer(fdatasync)
  → if proc still alive: SIGKILL + force-close
```

`metadata.json` 关闭时写入:`exitCode`、`signalCode`、`killed`(SIGKILL 兜底是否触发)、`bytesRead`、`linesParsed`。

### D-M2 · `-G 16M` 不可信,执行前后校验

`spawn.ts`:`adb logcat -g`(读当前 size) → `adb logcat -G 16M` → 再 `-g` 校验 effective。任一步失败或 effective ≠ requested → `events.jsonl` 写 `{type:"logcat_buffer_resize_failed", requested, effective, buffers, error}`,继续 session(不阻塞)。Metadata 记录 `logcatBuffer: {requested, effective, buffers}`。

### D-M3 · Pre-session ring buffer 污染

`spawn.ts` 使用 `adb logcat -T <session-start-epoch-seconds>`(`-T` 接受 epoch)。Fallback:parser 丢弃 `parsedTs < metadata.started_at` 的 entry,只对 raw 做。Raw 文件最前面 MCP 自己写一行 `--- session_start <runId> <iso-ts> ---` 作为人工回看锚。

### D-M7 · `stop_session(runId?)` 多 active 时的规则

- 全局 active session 数 = 1 → 允许省略 `runId`
- 数量 ≥ 2 → 返回 `{ error: "ambiguous_active_session", activeSessions: [{runId, deviceSerial, userId, packageName}...] }`
- Tool schema 描述同步更新

### D-M8 · Session scope 改为 `(deviceSerial, userId, packageName)` 三元组

- **lock 文件名**:`<deviceSerial>.<userId>.<package>.lock`
- **runId 不变**(仍是时间戳 + rand)
- **run folder 路径**:`<root>/<package>/u<userId>/<runId>/`(`u0` = 默认 user;work profile 通常 `u10`/`u11`;monorepo 多 module 但同 package 仍区分 userId)
- **`start_session` 入参**:新增 `userId?: number | "current"`,default `"current"`(`am get-current-user`)
- **`am/pm/dumpsys/uiautomator` 调用**:能带 `--user <id>` 的全加上(`am start --user`、`pm dump --user` 等)
- **§ C tool 表**:所有 read 类 tool 在 `list_runs` 返回中也带 `userId` 字段

### D-M9 · `clearLocalRunLogs` 安全语义

- **原默认**:`rm -rf <root>/<package>/`
- **新默认**:仅删 `closed_at != null` 且**无 live lock 对应**的历史 run 子目录
- **存在 active lock 时**:reject + 返回 `{ error: "clear_blocked_by_active_session", activeRuns: [...] }`
- **更激进的清理**:不在 v1 范围;agent 想清就 `rm -rf` 自己来,我们不替它扛锅

### D-M11 · MCP outputSchema + ToolAnnotations + clear-data 双重确认

- 每个 tool `register` 时同时给 Zod input schema + Zod output schema + ToolAnnotations:
  - `list_devices` / `list_runs` / `get_run_summary` / `get_app_state` / `search_logs` / `extract_crash_context`:`readOnlyHint: true`
  - `capture`:`readOnlyHint: false`(写 artifact)、`idempotentHint: false`
  - `tap` / `input_text` / `send_key` / `swipe`:`readOnlyHint: false`、`idempotentHint: false`、`destructiveHint: false`(可改 UI 状态但非数据破坏)
  - `app_control(action: "clear-data")`:`destructiveHint: true`,**同时**要求 `{ confirm: true }` 入参,否则 reject(我方加固,防 agent 误调)
  - `mark_event` / `start_session` / `stop_session` / `collect_bundle`:`readOnlyHint: false`、`idempotentHint: false`
- Tool 返回都包 `content:[{type:"text", text}]` + `structuredContent: {...}`(配合 m2)

### D-M12 · `search_logs` 分页

- 入参新增 `cursor?: string`
- 返回 `{ entries[], nextCursor?: string }`,无 next 时省略 `nextCursor`
- **硬上限**:`maxLimit = 500`(超过 reject);default `limit = 100`
- Cursor 实现:opaque base64 string,内部含 `{lastObservedSeq, fileOffset}`

### D-M13 · 多 orphan 顺序

- 按 `metadata.started_at` 升序处理
- **同 (device, userId, package) tuple** 内串行(每个 finalize 后再下一个)
- **跨 tuple** 可并发(默认串行;v1.1 看情况开 worker pool)
- 每个 orphan 处理失败 → 标 `status: "abort_recovery_failed"`,记 `error`,不阻塞其他 orphan

---

## E · Codex audit minor findings(2026-05-19)

5 条全收,改起来便宜:

### E-m1 · 字段命名统一 `deviceSerial`

- `list_devices` 输出字段从 `serial` 改为 `deviceSerial`
- `start_session` 等输入字段保持 `deviceSerial`
- Metadata 内统一 `deviceSerial`

### E-m2 · `get_run_summary` 返回形态对齐 MCP 习惯

- 返回 `{ content: [{ type: "text", text: <markdown> }], structuredContent: <meta-object> }`
- 不再用 `{ markdown, meta }` 这个内部对象形态
- 内部仍保留 `summary.md` 文件,`content[0].text` 直接读它

### E-m3 · `mark_event` 限制

- `name`:正则 `^[a-z0-9_.-]{1,80}$`
- `payload`:JSON 序列化后 ≤ 16KB,超过 reject `event_payload_too_large`
- Redaction 深度:object 递归到 5 层

### E-m4 · `capture` 绑 captureId

- 返回 `{ captureId: string, capturedAt: string, screenshotPath?, uiDumpPath?, uiSummary? }`
- 同次 capture 内两个 artifact 文件名共享 captureId:`screenshot-<captureId>.png` / `ui-<captureId>.xml`
- `events.jsonl` 写 `{type:"capture", captureId, kinds, ts}` 一行

### E-m5 · Session health 字段

- `get_app_state` 与 `get_run_summary.structuredContent` 同时增加 `sessionStatus: { device: "connected"|"degraded", logcat: "running"|"terminated"|"stopped", startedAt, lastLogAt, lastCommandAt }`
- `lastLogAt` 不在 metadata 持久化(避免每行 logcat 都 write metadata),改为 SessionManager 内存维护;orphan recovery 后近似取 jsonl 最后一行 ts

---

## F · 评估开源参考实现 — 结论:不借,自己写(2026-05-19)

- **日期**:2026-05-19
- **类型**:➕ 实施纪律(不改决策)
- **触发**:用户 clone 了两个开源 Android MCP 实现 ([`martingeidobler/android-mcp-server`](https://github.com/martingeidobler/android-mcp-server) TS、[`CursorTouch/Android-MCP`](https://github.com/CursorTouch/Android-MCP) Python),提议是否借鉴
- **结论**:**v1 全部 ground-up 自己写**。两个参考仓库 `./android-mcp-server/` 与 `./Android-MCP/` 留在 repo 目录下(已 gitignore)作为反面参考与未来 v2-F 评估材料,**不**作为 v1 代码来源

### 评估理由

逐项 spot-check 后,真正非平凡的"上游知识"只有 1 条:

- **adb `input text` 空格必须编码 `%s`** —— adb shell input parser 吞空格,这是一行文档没写的暗坑。来源参考 `android-mcp-server/src/adb.ts:46-61` 的 `escapeShellText`。我们 v1 在 `server/src/adb/input.ts` 实现 `escapeAdbInputText()` 时**直接采用这条规则**(纯 domain knowledge,非代码借用,不需要 attribution)。

其余考虑过的"借鉴项"经评估后全部撤销:

| 原借鉴项 | 撤销理由 |
|---|---|
| `discoverPath()` SDK fallback | 9 行自己写,且要加 Linux `~/Android/Sdk` 默认值 |
| `exec-out screencap -p` Buffer 返回 | adb 通用知识,无版权 |
| `uiautomator dump /dev/tty` + sdcard fallback | codex audit M6 独立得出同一方案,v1-spike-C 已锁,不算"借" |
| XML regex 解析 `<node>` | plan open decision #7 已锁 regex 路线;参考实现的字段命名与我们 schema 不一致,重写更清爽 |

### 为什么 v1 ground-up 反而更稳健

两个参考实现都是"通用 adb 自动化工具",**不解决** debug 证据采集问题。我们 v1 设计里有它们都没有的关键能力:

- **事实源完整性**:字节级 raw tee + streaming decoder([§ C-1](#c-1--raw-通道字节级-teeparser-不可污染事实源))
- **multi-process 真实形态**:UID-based filter + `(deviceSerial, userId, packageName)` 三元组([§ C-2](#c-2--logcat-filter-改为-uid-based配合-c-2m8-三元组) + [§ D-M8](#d-m8--session-scope-改为-deviceserial-userid-packagename-三元组))
- **Logcat 截断/丢失防御**:strict line buffer + dropout marker + 多行栈归并([§ A](#a--logcat-防御四件套q2-增量))
- **健壮 shutdown**:SIGTERM → drain → SIGKILL fallback + metadata 记 exitCode([§ D-M1](#d-m1--shutdown-顺序))
- **Lock-aware orphan recovery**([§ C-5](#c-5--orphan-recovery-强制-lock-owner-校验))
- **Session-aware 证据链**:tools-only + commands/events 双流 + (runId 必传)
- **MCP best practice**:`outputSchema` + `ToolAnnotations` + cursor 分页([§ D-M11](#d-m11--mcp-outputschema--toolannotations--clear-data-双重确认) + [§ D-M12](#d-m12--search_logs-分页))

借这两个参考仓库的代码会把它们"通用 adb 工具的简化思路"心智带进来,反而拖低标准。

### 反面参考价值(保留 gitignored,不删)

这两个仓库作为"我们故意不做的形态"留在 repo 目录,review 时仍有价值:

- `android-mcp-server/src/index.ts:613` 的 `adb_shell(command)` — 验证 § 显式 out-of-scope 第 1 行的必要性(escape hatch = RCE 面)
- `android-mcp-server/src/index.ts` 单文件 25 个 tool — 验证我们 `server/src/mcp/tools/*.ts` 分文件组织的必要性(它的 test 写 21 个 tool 但实际 25 个,代码与 test 已 drift)
- `Android-MCP/src/android_mcp/__main__.py:192` 的全局 `mobile = Mobile()` — 验证 (deviceSerial, userId, packageName, runId) session 模型的必要性
- `Android-MCP` 的 uiautomator2 / Pillow 依赖 — 验证"不走 AccessibilityService、runtime 仅 SDK + Zod"双锁的必要性

### v2 评估占位

[`backlog.md` v2-F · Element-based interaction](./backlog.md#v2-f--element-based-interaction-mobile-mcp-评估) 启动时,**那时**再回看 `Android-MCP/src/android_mcp/tree/service.py:29-49` 的 `get_interactive_elements` 与 `tree/service.py:96+` 的 `annotated_screenshot`,看是否能在 element-based selector 设计中复用思路(注意:仍然不直接借代码,只借设计 idea)。前提是它的所有操作必须能包进我们的 commands/events 证据链。

---

## G · MCP best practices 对齐(Audit Round 2,2026-05-19)

- **日期**:2026-05-19
- **类型**:♻️ 翻案(tool 命名 + tool 数)+ ➕ 增量(schema 严格性、CHARACTER_LIMIT、register helper)
- **触发**:用户 load 了 `mcp_best_practices.md` 与 `node_mcp_server.md`(skill-dev:create-mcp),codex 第二轮 audit
- **影响范围**:design-lock § C(tool 清单、命名、数量)、amendments § D-M11(annotation matrix)、§ D-M12(cursor)、v1-implementation-plan Phase 0 / Phase 1 / 所有涉及 tool 注册的 phase
- **共识**:6 个 major + 3 个 minor 全收

### G-1 · Tool 命名:`android_debug_` 前缀(R2-M1)

♻️ 翻案 § C 16 个 tool 名,加 `android_debug_` 前缀。

**理由**:`android_` 太宽,通用 Android automation MCP / mobile-mcp / Android-MCP 都会先抢 `android_*`;我们 server 核心是 debug evidence,prefix 也定位到这一层。

完整命名表见 [§ G-Final tool inventory](#g-final--final-tool-inventory17-个)。

### G-2 · 拆 `clear-data` 出 `app_control` 成独立 tool(R2-M4)

♻️ 翻案 § C 第 5 项与 § D-M11 注解。

- `android_debug_app_control` 入参 `action` 枚举改为 `"launch" | "restart" | "stop"`(去掉 `"clear-data"`)→ 全部非 destructive,统一 `destructiveHint: false`
- 新增 `android_debug_clear_app_data({ runId, confirm: true })`,单独 destructive tool;`destructiveHint: true`、`{confirm: true}` 入参缺省 reject
- **理由**:`destructiveHint` 在 multi-action tool 上无法对所有 action 同时准确表达;拆出后语义清晰,客户端可以更精确地展示风险提示

### G-3 · `list_runs` 加 cursor pagination(R2-M5)

➕ 增量 § C 第 15 项与 § D-M12 一致化。

- `android_debug_list_runs` 入参增加 `cursor?: string` + `limit?: number`(default 20,max 100)
- 返回 `{ runs[], nextCursor?: string, hasMore: boolean, totalCount?: number }`
- Cursor opaque base64,内部含 `{lastStartedAt, lastRunId}` 用于 stable sort 续读
- **`android_debug_list_devices` 不加 cursor**:设备集合天然小(单机几台),分页是过度设计

### G-4 · Zod schema 锁死 `.strict()` + bounds(R2-M6)

➕ 增量,实施纪律。所有 MCP-facing input schema 必须:

1. **`.strict()`**:`z.object({...}).strict()`,拒绝 unknown keys(防 agent 拼错被宽松吞)
2. **字段 bounds**:
   - 字符串:`min`/`max`,如 `name: z.string().min(1).max(80)`
   - 数字:`int()` + `min`/`max`,如 `limit: z.number().int().min(1).max(500)`
   - 数组:`min`/`max` items
3. **可读错误信息**:每个 `.min/.max/.regex` 写第二参 message,如 `.min(1, "Name required")`
4. **覆盖范围**:`query`/`text`/`name`/`label`/`limit`/`beforeLines`/`afterLines`/`durationMs`/`x`/`y` 等全部必有 bounds

不遵守即 Phase 10 hardening 不通过。

### G-5 · `RESPONSE_CHAR_LIMIT = 25000` 作为最终保险(R2-M2)

➕ 增量,工程纪律。

- **正常路径**:cursor + 窗口截取(crash context ±200 行、search_logs limit 100)
- **异常路径**:tool 序列化后 character 仍 > 25000,**不静默截半数据**,而是:
  - `structuredContent.truncated = true`
  - `structuredContent.truncationMessage` 包含原 size + 截后 size + 减少方案(如 "提示 `cursor` 续读 / `level=E` 缩范围 / `beforeLines=50` 缩窗口")
  - `content[0].text` 同步说明
- **限定**:RESPONSE_CHAR_LIMIT 是 v1 全局常量,放 `server/src/mcp/constants.ts`
- **理由**:debug 工具最容易遇到 ① 异常长 log line(stack chain 千行)② 异常多 runs;cursor 是正常路径,CHARACTER_LIMIT 是兜底

### G-6 · Register helper 强制 tool 注册契约(R2-m1)

➕ 增量,实施纪律。`server/src/mcp/register.ts` 提供唯一 tool 注册入口:

```ts
function registerDebugTool(server, name, config, handler):
  - name: 必须以 `android_debug_` 前缀
  - config 必含: title, description, inputSchema (Zod .strict()), outputSchema (Zod), annotations (4 hints all set)
  - description 必含四段: "Use when", "Args", "Returns", "Errors"
    - 缺一段 → throw at registration time, server boot fail
  - handler 返回 必须经 outputSchema.parse() 才能附 structuredContent
```

Tool 文件不允许直接调用 `server.registerTool(...)`;只能走这个 helper。Phase 10 hardening 一轮 audit 所有 tool 注册路径。

### G-7 · `outputSchema` 强制(R2-m3)

➕ 增量 § E-m2。`structuredContent` 不再是"约定"而是"契约":每个 tool 定义 Zod `outputSchema`,handler 返回前必须 `outputSchema.parse(structuredContent)`,parse 失败 = tool 实现 bug,直接抛(不 swallow)。

### G-8 · Annotation matrix 显式标 `openWorldHint`(R2-m2,更新 § D-M11)

♻️ 补齐 § D-M11 annotation 表(原表只覆盖 readOnly/destructive/idempotent):

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `android_debug_list_devices` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_list_runs` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_get_app_state` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_get_run_summary` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_search_logs` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_extract_crash_context` | ✅ | ❌ | ✅ | ✅ |
| `android_debug_start_session` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_stop_session` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_mark_event` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_app_control` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_clear_app_data` | ❌ | **✅** | ❌ | ✅ |
| `android_debug_tap` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_input_text` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_send_key` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_swipe` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_capture` | ❌ | ❌ | ❌ | ✅ |
| `android_debug_collect_bundle` | ❌ | ❌ | ❌ | ✅ |

所有 tool `openWorldHint: true`(交互真实设备/文件系统)。

### G-Plan note · plan Phase 0 描述与代码 drift

R2-M3 提到 plan Phase 0 文字写的是 `new Server({name,version},{capabilities:{tools:{}}})`,但实际 Phase 0 代码已经是 `new McpServer({name,version})`(SDK 1.29 把 `Server` deprecated 时改的)。**Plan 文字落后,代码是 canonical**;不就地改 plan,以本 amendment 为准。

### G-Final · Final tool inventory(17 个)

| # | Tool | 备注 |
|---|---|---|
| 1 | `android_debug_list_devices` | |
| 2 | `android_debug_start_session` | 入参含 `projectRoot?` / `userId?` / `clearLocalRunLogs?` / `clearDeviceLogcat?` / `logcatBufferSize?` / `launchOnStart?` |
| 3 | `android_debug_stop_session` | 入参 `runId?`,active 数=1 时可省 |
| 4 | `android_debug_mark_event` | name regex + payload size ≤ 16KB |
| 5 | `android_debug_app_control` | action: `"launch" \| "restart" \| "stop"`(去掉 clear-data) |
| 6 | `android_debug_clear_app_data` | **NEW**(G-2 拆出),destructive,要 `{confirm:true}` |
| 7 | `android_debug_get_app_state` | |
| 8 | `android_debug_tap` | |
| 9 | `android_debug_input_text` | mode: ascii / unicode-via-clipboard(v1-spike-B) |
| 10 | `android_debug_send_key` | key 白名单 |
| 11 | `android_debug_swipe` | |
| 12 | `android_debug_capture` | kinds + captureId |
| 13 | `android_debug_search_logs` | cursor + maxLimit 500 |
| 14 | `android_debug_extract_crash_context` | beforeLines/afterLines 默认 ±200 |
| 15 | `android_debug_get_run_summary` | content + structuredContent |
| 16 | `android_debug_list_runs` | **G-3 新增 cursor + limit**;返回 `{runs, nextCursor?, hasMore, totalCount?}` |
| 17 | `android_debug_collect_bundle` | logs: `"none"\|"redacted"\|"raw"` |

