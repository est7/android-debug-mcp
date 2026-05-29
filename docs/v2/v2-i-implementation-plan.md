# v2-I 实施计划 — Unified Timeline (logcat + events)

状态:locked(grill 定稿 2026-05-29,选项 α)。执行者:Codex。self-contained 执行规格,设计已锁定,**不要重新推导**。

## 0. 背景与目标

v2-H 的多源时间线(`extract_evidence_context.sources`)只合并 **evidence sources(poppo_nav + poppo_http)**;logcat 与 events 不在内。结果 B(崩溃三角)、D(交互因果)拿不到「日志与 http/nav 的真实先后」。

v2-I 把时间线扩到 **logcat + events**,一步同时推进 B 和 D:
- **B 崩溃三角**:崩溃 marker 上看到 栈(via ref)/ 前后 logcat / http / nav 一条 tsMs 线。
- **D 交互因果**:一次 tap 的 ts 当 marker → 看「点击后 nav 切换 + 接口 + 日志」的真实交错。

**核心难点(α 选定):logcat 只有 `tsRaw`(设备 wall-clock,无年份),系统里无 tsRaw→epoch 换算。** 必须新造换算器(年份从 session 补、用 `deviceTimezone` 转 epoch)才能把 log 行排进 epoch 时间线。events 已带 ISO `ts`(`appendEvent` 盖),ISO→epoch 直接用,无需换算。

> 关键利好:http/nav 的 `tsMs`(`System.currentTimeMillis`)与 logcat `tsRaw` **同为设备时钟**。换算正确后二者在同一时钟上交错,无跨时钟漂移——交错顺序是真实可信的。

## 1. 执行约定(每 phase 遵守)

- **Runner 是 `vitest run`**(用 `bun run test`),**不是 `bun test`**。
- **TDD**:先 RED 再 GREEN。
- **Gate**(每 phase 收尾全跑):`bun run typecheck && bun run lint && bun run test` 三绿。
- **Per-phase codex audit gate**:实现 + gate 绿后出改动摘要待审,通过再进下一 phase。
- **不自动 commit**。语言:代码/标识符/测试 English,本文 rationale 中文。
- MCP input 校验失败经 SDK 表现为 `{isError:true}`(memory `mcp-sdk-input-validation-surfaces-as-iserror`)。

## 2. 锁定的设计决策(勿翻案)

- **交付 = 继续扩 `extract_evidence_context.sources`**,不新开 `timeline` 工具(与 v2-H H3 的「扩现有工具」一致;复用 H3 的 marker-window + 合并 + 截断 + 聚合 command 机制)。`sources` 元素新增可识别的两个**伪 source**:`logcat`、`events`(它们不是 profile 里的 EvidenceSource,handler 特判分派)。
- **logcat 伪 source 必须带收窄过滤**(level / tags / pids / query 之一),复用 search_logs 的「no fetch-all」纪律;只 `excludeTags` 不算收窄。否则 `query_malformed`。
- **events 伪 source** 过滤:`typeIn?: string[]`(缺省全收;但建议默认排除高频 `evidence_pulled` 噪声——见 I2)。
- **tz 为 null 时**(`deviceTimezone` 不可读):logcat 无法定位 → **该伪 source 贡献空 + 一条 warning**(`logcat timeline unavailable: device timezone unknown`),不 fail 整次调用;events/nav/http 照常。
- **合并仍按 epoch `tsMs` 升序**;`limit` 作用于合并后;超限截断 + warning(no silent cap),沿用 H3。
- **drill-down ref**:logcat 行→`search_logs`(rawLineNo / sinceTs / cursor);crash 事件→`extract_crash_context`(crashIndex);nav/http 同 v2-H。
- **不在 v2-I**:action 工具的一键 `verifyAfter`(D 用 tap-ts 当 marker 已够);性能轴 C;`search_evidence` 多源。

---

## Phase I1 — `tsRaw` → epoch 换算器(MCP 仓,纯函数,hermetic)

### I1.1 实现
新增 `server/src/logcat/ts.ts`:

```
export function logcatTsToEpochMs(
  tsRaw: string,            // "MM-DD HH:MM:SS.mmm"
  sessionStartMs: number,   // 用于补年份
  deviceTimezone: string,   // IANA tz;调用方保证非 null
): number | null
```

算法:
1. 严格解析 `^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$`;不匹配返回 `null`(永不抛)。
2. 候选年份 ∈ `{Y-1, Y, Y+1}`,其中 `Y` = `sessionStartMs` 在 `deviceTimezone` 下的年份(用 `Intl.DateTimeFormat`,复用 `poppo_http/source.ts` 的 `localDateInZone` 思路)。
3. 对每个候选年,把 `{year, MM, DD, HH, MM, SS, mmm}` 当作 `deviceTimezone` 的**本地 wall-clock** 转 epoch ms(tz-aware:先按 UTC 组装 candidate,再用 `Intl.DateTimeFormat`(timeZone)在该 instant 求 tz 偏移并校正一次以处理 DST 边界)。
4. **选距 `sessionStartMs` 最近的那个年份对应的 epoch**(鲁棒处理 12 月日志落在 1 月 session 的跨年;logcat 保留 ≤3 天,正确年与错误年相差 ≈1 年,closest 必中)。
5. tz 字符串非法(`Intl` 抛 RangeError)→ 返回 `null`。

### I1.2 测试 `server/tests/logcat/ts.test.ts`(RED 先)
- 正常:同年 `MM-DD` 在 session tz 下转 epoch,误差 = 0(用固定 tz 如 `Asia/Shanghai` + 已知 epoch 反推)。
- 年份补全:session 在 2026-01 而 tsRaw 是 `12-31 ...` → 选 2025(跨年回退)。
- DST 边界:用一个有 DST 的 tz(如 `America/New_York`)在切换日 02:30 这类时刻,断言偏移校正正确(或至少单调、不偏 1 小时)。
- malformed(缺 `.mmm` / 乱串)→ `null`。
- tz 非法 → `null`。

### I1.3 Gate + audit

---

## Phase I2 — `extract_evidence_context.sources` 接 `logcat` + `events`(MCP 仓)

PUBLIC_IMPACT:`sources` 词汇扩展 + 输出多了两种 kind 的 digest 行。

### I2.1 handler 分派
在 H3 的 `sources` 循环里,按 `sourceQuery.source` 分支:
- `"logcat"`:
  - 校验收窄(level/tags/pids/query 至少一个),否则 `query_malformed`(消息复用 search_logs 风格)。
  - 若 `ctx.deviceTimezone === null`:push warning `logcat timeline unavailable: device timezone unknown`,贡献空,continue。
  - 扫 `runDir/logcat.jsonl`:逐行 parse → `logcatTsToEpochMs(tsRaw, sessionStartMs, tz)`;`null` 跳过;落在窗口 `[from,to]` 内且过滤命中的,产出 digest 行 `{ source:"logcat", tsMs, level, tag, pid, message: <截断 ~200 char>, rawLineNo }`。
  - 复用 search_logs 的过滤判定(把 `matches` 相关逻辑抽成可复用函数,或在 handler 内重写等价过滤;**优先抽小函数避免漂移**)。
- `"events"`:
  - 读 `runDir/events.jsonl`:逐行 parse → `Date.parse(ev.ts)` 得 epoch;落在窗口内 + `typeIn` 命中的,产出 digest 行 `{ source:"events", tsMs, type, ...摘要 }`:
    - `mark` → `{ name }`;`lifecycle` → `{ phase }`;`crash` → `{ crashType, topFrame?, ref: "crash#<index>" }`(index = 该 run 第几个 crash,供 `extract_crash_context` drill);`evidence_pulled` 默认建议**不返回**(噪声),除非 `typeIn` 显式要。
- 其它:沿用 H3 的 evidence dispatch(nav/http)。

### I2.2 合并/截断/输出
- 各来源行汇入同一数组,**按 `tsMs` 升序**(tiebreak:source 名,沿用 H3),`limit` 截断 + warning。
- statsRun 仍各源累加(logcat/events 无 pull,filesScanned 可计本地文件;不破坏既有 shape)。
- 输出沿用 `{ records, warnings?, statsRun, tsMsRange }`。

### I2.3 description
写明:`sources` 现支持 `logcat`(需收窄过滤;tz 未知则贡献空 + warning)与 `events`(typeIn 过滤;crash 行带 ref 走 extract_crash_context);仍按 tsMs 合并;多源不分页(超 limit 截断 + warning)。

### I2.4 测试(RED 先)`server/tests/mcp/search_evidence.test.ts`(或新 file)
- fixture:同窗口 nav + http + logcat + events 交错 → `sources:[{poppo_nav},{poppo_http,pathPrefix:"/"},{source:"logcat",level:"W"},{source:"events"}]` → 返回**按 tsMs 升序、含四种 kind** 的 digest;断言 logcat 行用换算后的 epoch 正确插在 http/nav 之间。
- `{source:"logcat"}` 无收窄 → `query_malformed`。
- tz 为 null(用无 tz 的 session ctx)→ logcat 贡献空 + warning,其它源照常。
- crash event 行带 `ref` 且 `extract_crash_context(crashIndex)` 可据此取栈。
- 多源超 limit → 截断 + warning。
- `evidence_pulled` 默认不出现,`typeIn:["evidence_pulled"]` 时出现。

### I2.5 Gate + audit

---

## Phase I3 — 真机验收(B + D)

扩 `server/tests/e2e/v2h_acceptance.test.ts`(或新建 `v2i_acceptance.test.ts`),opt-in `ANDROID_DEBUG_E2E=1`:
- **B 崩溃三角**:制造/定位一次 crash(若难稳定复现,则用一次已知 error 日志窗口替代),`extract_evidence_context(sources:[{events},{source:"logcat",level:"E"},{poppo_http,pathPrefix:"/"}])` 锚在 crash/error marker → 断言时间线含 events(crash/mark)+ logcat(E)+(可能)http,按 tsMs 升序,crash 行 ref 能 drill 到栈。
- **D 交互因果**:一次 tap → 用 tap 返回 ts 当 marker → `sources:[{poppo_nav},{poppo_http,pathPrefix:"/"},{source:"logcat",level:"I",tags:[<app tag>]}]` → 断言点击后 nav 切换 / http / 该 tag 日志在同一条线上、tsMs 升序。
- 物证落 `docs/v2/test-plan-v2i.md`(对标 `test-plan-v2g-evidence.md`)。

---

## 依赖与顺序
I1(换算器,纯 hermetic)→ I2(handler 扩展,hermetic fixture)→ I3(真机)。I2 测试用 fixture 不依赖真机;I3 需真机(且 logcat 时间线依赖 I1 换算正确)。v2-I 不依赖 v2-H 的 H4/H5 装包(logcat/events 是设备本地拉的 run 文件,nav 才需 producer)——但 I3 的 D 场景若要 nav 行,需 H4 已装。

## 不在范围(v2-I 明确不做)
- action 工具 `verifyAfter` 一键(D 用 tap-ts 当 marker 已够)。
- 性能轴 C(gfxinfo/meminfo/启动)。
- `search_evidence` 多源合并;dedicated `timeline` 工具(继续复用 extract_evidence_context)。
- logcat 换算的极端正确性(设备时钟与日志时钟假定一致;跨年用 closest-year 启发式;DST 边界 ±1 行可能错位)——作为已知 caveat 标注,不追求 100%。
