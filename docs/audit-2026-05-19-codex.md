# Codex Audit — 2026-05-19

Reviewer: **codex**(经 AMQ orch-dispatch 派发,session=`collab`)
Audit scope: [`design-lock-v1.md`](./design-lock-v1.md) + [`decision-amendments.md`](./decision-amendments.md) + [`v1-implementation-plan.md`](./v1-implementation-plan.md) + [`backlog.md`](./backlog.md) + [`../suggestion-chat.md`](../suggestion-chat.md)

本文件**原文留档**。决策落地见 [`decision-amendments.md`](./decision-amendments.md) § C / § D / § E,推翻 / 中立 / 待 spike 见 [`backlog.md`](./backlog.md) v1-issues 段。

---

# Audit Report — Android Debug MCP v1

## Findings

### Critical

- **[C1]** [v1-implementation-plan.md:Phase 4 / design-lock-v1.md § B-11] — `logcat.raw.txt` 被描述为 raw byte-tee,但 Phase 4 的 line-buffer/parser 义务容易把 raw 路径放到 UTF-8 解码之后,这样半截 UTF-8、无换行尾巴、parser bug 都会污染"事实源"。把 stdout 的 `Uint8Array` 先 byte-for-byte tee 到 raw writer,parser 只消费第二路 `TextDecoder({fatal:false})` streaming 输出,并在 jsonl 里记录 `rawLineNo` + `rawByteCount`。
- **[C2]** [design-lock-v1.md § B-11 / v1-implementation-plan.md:Phase 4 `pid_tracker.ts`] — Channel B 以 app PID 为主会漏 multi-process app、isolated service、WebView renderer、crash 前刚 fork 的短命进程,`pidof` 轮询补不上时 jsonl 会静默缺关键行。启动时解析 `cmd package resolve-activity`/`dumpsys package` 得到 `userId` 与 app UID,logcat 格式追加可用的 `uid` 字段,过滤规则改成 `uid == appUid OR pid in knownPids OR critical system tag`,并把 `processName` 作为 enrichment 而不是过滤前提。
- **[C3]** [design-lock-v1.md § B-10 / v1-implementation-plan.md:Phase 2 `resolveRunRoot()`] — run root 绑定 MCP 进程的 `git rev-parse --show-toplevel`,在 Claude Desktop/Cursor stdio 启动时很可能落到 MCP server repo、用户 home 或 monorepo 顶层,不是正在调试的 Android app repo。`start_session` 增加必填或强提示的 `projectRoot`/`runRoot` 解析,优先使用 `ANDROID_DEBUG_MCP_RUN_ROOT`,并把 resolved root 写进 metadata;无明确 project root 时只落 `~/.android-debug-mcp/runs/` 并返回 `runRootSource:"fallback"`。
- **[C4]** [design-lock-v1.md § F Bundle 内容 / backlog.md v2-E] — baked-in redaction 只覆盖 `events.jsonl` 与 `commands.jsonl`,但默认 bundle 仍包含 `logcat.jsonl`,而 logcat 里经常有 Authorization、Cookie、手机号、设备 ID、业务 payload。v1 就把 `logcat.jsonl` 输出前 redaction 纳入 Phase 5,或者把 bundle 参数改成 `logs:"none"|"redacted"|"raw"` 且默认 `redacted`,禁止默认 bundle 携带未脱敏日志。
- **[C5]** [design-lock-v1.md § D / v1-implementation-plan.md:Phase 8] — orphan recovery 只看 `closed_at == null` 会把"另一个仍活着的 MCP 正在写的 run"误判成 orphan,尤其 lockfile 残留但 pid 仍 alive 时会发生双 writer/finalize 竞态。boot scan 先校验 lock `{pid,startTime,runId}`:owner alive 则不 finalize,标 `recover_blocked_active_owner` 并拒绝同 tuple `start_session`;owner stale 才 replay/finalize,成功后原子删除 lock。

### Major

- **[M1]** [v1-implementation-plan.md:Phase 4 Concurrent stream lifecycle] — `stop_session` 只说"优雅终止 adb child、flush、等 parser drain",没有规定 SIGTERM/SIGKILL 与 stdout EOF 的顺序,macOS 上 `Bun.spawn().stdout` 是 `ReadableStream`,kill 后仍可能有已缓冲 chunk 未被 reader 消费。实现为 `SIGTERM -> wait proc.exited and reader EOF with deadline -> drain remaining chunks -> close writers -> SIGKILL fallback`,并把 `exitCode/signalCode/killed/bytesRead/linesParsed` 写入 metadata。
- **[M2]** [decision-amendments.md § A / design-lock-v1.md § F Logcat buffer size] — `adb logcat -G 16M` 是 device-global mutable state,不同设备可能 cap、拒绝或只对部分 buffer 生效,设计里"每次设置,不还原"会把外部环境改变藏起来。执行 `-G` 前后都跑 `adb logcat -g`,记录 `requested/effective/buffers/error`,失败时写 `logcat_buffer_resize_failed` event 后继续,不要把 16M 当事实。
- **[M3]** [design-lock-v1.md § D / v1-implementation-plan.md:Phase 4 Verify] — 默认不 `logcat -c` 是对的,但 `adb logcat` 会先吐已有 ring buffer,导致 run 内 raw/jsonl 混入 start 前的旧 crash。spawn 时使用 `-T <sessionStart>` 或 parser 丢弃早于 `metadata.started_at` 的 entry,并在 raw 里插入 MCP 自己的 `session_start` marker 作为人工回看边界。
- **[M4]** [v1-implementation-plan.md:Phase 4 parser/crash_marker] — `-v threadtime` 没有 year/timezone,跨午夜、跨设备时区或 orphan replay 后只靠文本时间会让 crash window 排序不稳定。jsonl entry 增加 `observedSeq`, `rawLineNo`, `parsedLocalTs`, `sessionYear`, `deviceTimezone?`,检索和 crash context 默认按 `observedSeq` 截窗口,时间只做筛选条件。
- **[M5]** [decision-amendments.md § B / v1-implementation-plan.md:Phase 6 `input_text`] — v1 走 `adb shell input *` 合理,但 `input_text` 若承诺任意 `text` 会在空格、百分号、shell quoting、Unicode、IME 组合输入上产生假成功。v1 schema 明确 `input_text` 只支持 ASCII printable + documented escaping,不支持内容返回 `unsupported_text_input`;需要任意文本时新增 `set_clipboard_and_paste` 或推迟到 sidekick/IME 方案。
- **[M6]** [v1-implementation-plan.md:Phase 6 capture] — capture 计划用 `uiautomator dump` + `adb pull`,这会留下设备侧临时文件,并可能读到旧 dump 或撞上存储权限/多用户路径。改成优先 `adb exec-out uiautomator dump /dev/tty` 直接落本地 artifact;仅在设备不支持时 fallback 到唯一文件名 `/sdcard/Android/data/<package>/cache/android-debug-mcp-<runId>.xml` 并校验 XML root。
- **[M7]** [design-lock-v1.md § C `stop_session` / design-lock-v1.md § B-9] — `stop_session { runId? }` 与 `(device, package)` 单例组合后仍允许同 device 不同 package 多 active session,省略 runId 会停错或必须靠隐藏 active-session 全局状态。规则改成:active session 数量为 1 时允许省略,否则返回 `ambiguous_active_session` + active list;文档和 schema 写死该行为。
- **[M8]** [design-lock-v1.md § B-9 / v1-implementation-plan.md:Phase 2 lock] — `(device, package)` 没有 `userId`,会把 work profile、secondary user、same package cloned app 误合并,ADB `am/pm/dumpsys` 也会默认 current user 而不是目标 user。session scope 改为 `(deviceSerial, userId, packageName)`,`start_session` 增加 `userId?: number | "current"`,所有 `am/pm/dumpsys/uiautomator` 能带 `--user` 的地方统一从 session 取值。
- **[M9]** [v1-implementation-plan.md:Open decision #11 `clearLocalRunLogs`] — `clearLocalRunLogs` 默认 `rm -rf <root>/<package>/` 会删除同 package 其他 user/profile 或活跃 session 的证据,这是 debug 工具里最容易造成不可逆证据丢失的开关。改成只清理 `closed_at != null` 且不匹配任何 live lock 的历史 run;存在 active lock 时拒绝并返回 `clear_blocked_by_active_session`。
- **[M10]** [design-lock-v1.md § B-10 / backlog.md v1.1-C] — CI/container fallback 只写 `~/.android-debug-mcp/runs/` 会让测试产物位置不可预测,也不利于 artifact 收集。支持 `ANDROID_DEBUG_MCP_RUN_ROOT` 作为最高优先级,测试与 CI 必须显式设置到 `$RUNNER_TEMP/android-debug-runs` 或 repo-local temp,并在 `list_runs` 返回 `root`。
- **[M11]** [design-lock-v1.md § C / v1-implementation-plan.md:Phase 10] — tool 返回形态只有 prose 级 `{ summary, runPath }`/`entries[]`,没有 MCP `outputSchema`、`structuredContent` 与 ToolAnnotations,客户端难以区分 read-only、destructive、idempotent。每个 tool 注册时补 Zod output schema 与 annotations:`list/search/get/capture` 标 `readOnlyHint` 按实际副作用拆分,`app_control(clear-data)` 和 `clearLocalRunLogs` 标 destructive,interaction 标 non-idempotent。
- **[M12]** [design-lock-v1.md § C `search_logs`] — `search_logs` 只有 `limit` 没有 cursor,高频日志下 agent 要么拿不到下一页,要么重复扫全文件导致 token 与 I/O 浪费。返回 `{entries,nextCursor}` 并要求下一次用 `cursor` 续读;同时设置 `maxLimit` 硬上限,避免一次 tool call 读爆上下文。
- **[M13]** [v1-implementation-plan.md:Phase 8 recovery] — 多个 orphan 同时存在时没有顺序规则,如果同 device/package 连续 crash 两次,后启动的 replay 可能先 finalize,summary 时间线反而倒置。按 `metadata.started_at` 升序恢复,同 tuple 内串行执行;每个 orphan finalize 后再释放/修复 lock,跨 tuple 才允许并发。

### Minor

- **[m1]** [design-lock-v1.md § C `list_devices` / `start_session`] — `list_devices` 输出字段叫 `serial`,但输入字段叫 `deviceSerial`,同一概念两个名字会增加 agent schema 记忆成本。统一为 `deviceSerial` 输出,或保留 `serial` 时 `start_session` 也接受 `serial` alias 并在 metadata canonicalize 为 `deviceSerial`。
- **[m2]** [design-lock-v1.md § C `get_run_summary`] — `{ markdown, meta }` 是工具内部对象风格,但 MCP 客户端更容易消费 text content + structured metadata。返回 `content:[{type:"text",text:markdown}]` 与 `structuredContent:{meta}`;内部仍可保留 `summary.md` 文件。
- **[m3]** [design-lock-v1.md § C `mark_event`] — `mark_event {name,payload?}` 没有 name 格式、payload 大小和 redaction 深度限制,会把 events.jsonl 变成任意 JSON dump。限定 `name` 为 `[a-z0-9_.-]{1,80}`,payload JSON 序列化后最大 16KB,超过返回 `event_payload_too_large`。
- **[m4]** [design-lock-v1.md § C `capture`] — `capture(kinds:[...])` 合并 screenshot/ui_dump 是对的,但返回里没有把 screenshot 与 ui_dump 绑定成同一观察点。返回增加 `captureId` 与同一个 `capturedAt`,两个 artifact 文件名共享该 id,events.jsonl 也写同一 id。
- **[m5]** [design-lock-v1.md § D device disconnected] — degraded state 禁止接续是正确的,但没有 active logcat health 字段,用户只能到失败时才知道采集已经断了。`get_app_state` 或 `get_run_summary` 增加 `sessionStatus:{device,logcat,startedAt,lastLogAt,lastCommandAt}`。

## Correctly locked(不要动的决策)

- [design-lock-v1.md § 项目身份 / § A-1] — Session-centered evidence collector 是正确抽象,避免把 MCP 做成"吐一屏 logcat"的浅工具。
- [design-lock-v1.md § A-6 / § 显式 out-of-scope] — 不提供 `adb_shell(cmd)` escape hatch 是对的,否则 MCP server 直接变成本机/设备 RCE 面。
- [design-lock-v1.md § B-11] — raw + structured jsonl 双通道方向正确,raw 保事实、jsonl 保可查询性,只是 raw 必须位于所有解析之前。
- [decision-amendments.md § B / backlog.md v2-F] — v1 不嵌 mobile-mcp 是对的,element-based automation 会把 session evidence 与 UI automation 两个问题搅在一起。
- [design-lock-v1.md § B-13 / v1-implementation-plan.md:Phase 6] — interaction 必须 session-aware 的主规则是对的,低级操作进入 commands/events 才能形成可复盘证据链。
- [design-lock-v1.md § F `adb logcat -c`] — 默认不清设备 logcat 是对的,`logcat -c` 是设备级副作用,不该为了单个 run 破坏别的调试现场。
- [design-lock-v1.md § v1 验收] — 5 个 manual scenarios 覆盖 happy/crash/interaction/disconnect/orphan,是 v1 比 unit tests 更重要的验收骨架。
- [backlog.md v3-A / v3-D] — app-side sidekick 推迟到 v3 是对的,它解决业务状态与长日志旁路,不是 v1 ADB evidence collector 的必要条件。

## Top-3 priorities — 如果你来做 v1,你会先改的 3 件事

1. **先修 [C1] + [M1]**。Phase 4 是总预算 30% 的关键路径,但真正的成败点不是 parser 正则,而是"事实源不可污染 + shutdown 不丢尾巴";byte tee、streaming decoder、SIGTERM drain/SIGKILL fallback 一旦定错,后面的 orphan recovery、crash context、bundle 都会建立在不可信 raw 上。
2. **再修 [C2] + [M8]**。Android app 的真实形态经常是 multi-process + work profile/user profile,PID-only 与 `(device,package)` 单例会在最难排的 crash 上漏证据;把 UID/userId 纳入 session identity 和 filter 是 v1 能否服务真实 app 的分界线。
3. **最后修 [C3] + [C4]**。run 放错 repo 会让证据不可找、不可分享、不可清理;未脱敏 logcat 进默认 bundle 会让"证据采集工具"变成泄漏工具。这两个不改,即使 tools 全能跑通,也不适合交给其他同事使用。
