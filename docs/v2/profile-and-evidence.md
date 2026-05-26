# Android Debug MCP — v2-G Design Lock · Project profile + EvidenceSource adapter

Locked: 2026-05-25. Promoted from [`../backlog.md`](../backlog.md) § v2-G per
the docs promotion rule. codex paired as design reviewer across 4 pre-impl
plan reviews + 4 post-impl audits (Phase 3 / Phase 4 / Phase 5 (i) each got
its own cadence-A pair); every required fix landed before commit.

## 文档定位

v2-G = **adapter layer between MCP and project-specific evidence sources**.
v2-A 把源码映射规则 (`source/recipe.ts` BaseBindingActivity / ViewBinding 正则)
直接焊在 Poppo 上;v2-F.0 真机 acceptance 又冒了 3 条 lock-level amendments(MIUI
multi-window 不可观察、zod wire-shape transport-dependent、Poppo `hint` 结构性不可达)。
这两件事的共同根因:**MCP 在迁就单一 app 的"碰巧能用"形态**,没有抽象边界。

v2-G 的解法是开**第一个**通用 adapter 抽象 ——
[`server/src/profile/types.ts`](../../server/src/profile/types.ts):

- **`Profile`** —— 每个项目对应一个内置 profile,profile 声明它的 evidence sources。
- **`EvidenceSource`** —— 一个 source 对应一种产物形态(本期:Poppo 的
  `CustomHttpLoggingInterceptor` 写的 `http_*.jsonl`);source 用 `listDeviceFiles` /
  `pullFile` / `parseLine` / `matchQuery` / `redactForBundle` 桥接 device 数据到
  MCP 的通用 lazy-pull runtime。
- **`<projectRoot>/.android-debug-mcp/profile.json`** —— per-project 配置文件,
  `start_session` 时 MCP 读;vanilla 项目零文件。

v2-G v0.4.0 ships:

- 2 个新 tool:`android_debug_search_evidence`、`android_debug_extract_evidence_context`
  (tool 总数 21 → 23)
- 1 个 reference profile:`poppo-vone`,含 1 个 reference source:`poppo_http`
- `collect_bundle` 出口的 Q6 redaction wiring

**不引入** `SourceProfile` 抽象 / `source/recipe.ts` 的 Poppo-bake **暂留**。触发条件
= 真接入第二 app(预计 2026-06);到时候启动 v2-H 抽 `SourceProfile`,见
[`../backlog.md`](../backlog.md) § "known 技术债"。

本文件对齐 [`./element-interaction.md`](./element-interaction.md) 体例。v1 / v2-A /
v2-F 的决策与持久化格式仍然有效且不动;本文件只锁 v2-G 在它们之上**新增**的部分。

## Baked-in assumptions(不上桌的前提)

1. **MVP 范围是 only-evidence**(不抽 source-mapping)。v2-G grill Q1 锁定:不动
   `source/recipe.ts`,只搞 evidence layer。
2. **Profile 是内置的**(`server/src/profile/<name>/`),不是 user-supplied TS。
   `profile.json` 只携带 `{name, version}`,name 解析走 `findBuiltinProfile()`。
   理由(codex round-1 take-b):JSON-first + built-in named adapters;不默认
   projectRoot TS 动态 import,保留代码级 surface change。
3. **Lazy pull**(不主动同步)。Evidence files 留在 device,首次 `search_evidence`
   或 `stop_session` 才拉。Q5+ 用 mtime cache + filename-local-date 缩范围。
4. **Source 是装配-time 决策**,不是 runtime discovery。一个 Profile 在代码里
   声明它的 sources;不扫描、不动态注入。
5. **`response`/`error` 互斥**(schema 不变量),`text`/`textBytes`/`omittedReason==null`
   三态绑定(rev4 invariants)—— consumer 这边 strict enforce。
6. **Append-only evidence**(JSONL 不重写)。Producer 写新行,文件 mtime 增。
   Active file 上 stat 拿 mtime,与本地 cache 比较决定 pull/skip。
7. **Q6 redact 是 collect_bundle 的硬出口**,不是 search/extract 的过滤。Tool
   层返 raw record;bundle 层走 source.redactForBundle 一律删敏感字段值。

## v2-G Q1 – Q12 nodded decisions

下列决策于 2026-05-25 grill 期间全部 nod-locked,无后续翻案。

### Q1 — MVP 范围

**(b) only-evidence**(reject `(a) full-abstraction with SourceProfile`):
做 `EvidenceProfile` + `EvidenceSource` 接口 + `search_evidence` /
`extract_evidence_context` 工具 + Poppo HTTP adapter 作第一个 reference 实现;
不做 `SourceProfile` 抽离(v2-A `source/recipe.ts` Poppo-bake **暂留**)。

### Q2 — profile 选择机制

per-project `<projectRoot>/.android-debug-mcp/profile.json`,start_session 时 MCP
读;vanilla 项目零文件。

`profile.json` schema(`.strict()`):

```json
{ "name": "poppo-vone", "version": 1 }
```

未来扩字段(覆盖 / 覆盖列表 / 自定义敏感字段表 等)走 `version: 2` SemVer bump。
consumer **必须**拒绝未知 `version`;producer **不得**在同一 `version` 改字段语义。

### Q3 — profile 内部数据结构

Profile 用 TS interface(`server/src/profile/types.ts`)+ `Map`/`record` 内置存放。
不通过外部配置文件携带 source 实现(否则会回到 v2-A 重蹈)。

### Q4 — search_evidence shape

**discriminated-union by source**:

```ts
z.object({
  runId: z.string(),
  query: z.object({ source: z.string().min(1).max(64) }).passthrough(),  // strict on source, lax on rest
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
}).strict();
```

每个 source 自定义 strict zod schema 声明它接受的 query fields(`pathPrefix` /
`methodIn` / `outcome` / `excludeHeartbeat` / `tsMsRange` / `hostContains` /
`durationMsGte` / `errorTypeIn` —— 见 § Source: poppo_http 的 querySchema)。
Tool 层只校验 `query.source` 是字符串;source 校验自己的字段。

**Phase 3 contract amendment(codex review)**:Q4 原文要求 tool 边界
`z.discriminatedUnion("source", [...])`;但 MCP SDK 要求 inputSchema 在
`registerTool` 时静态注册,arms 是 per-runId profile 动态的(vanilla session 0 arms;
0-arm `discriminatedUnion` 在 zod 构造期就炸)。最终落点:tool 边界 loose passthrough,
handler 进入后通过 `queryDispatch.dispatchQuery` 用 `source.querySchema.strict().parse`
做 per-source 严格校验。Q4 strict 精神保留(每个 source 仍 strict);Q11 soft-empty 不变。

### Q5+ — 时间窗驱动 lazy pull

- `sessionStartMs` 作 lazy-pull 时间窗左边界
- filename `<localDate>` 做 file selection(`http_<yyyy-MM-dd>_<idx>.jsonl`)
- 1 天 buffer 兜跨夜(session 跨午夜或 device tz 偏移)
- active file mtime cache:`<runDir>/evidence/<source>/.mtime-cache.json`
- `stop_session` 触发 force seal(mtime equality 不 skip,全部重 pull)

**Phase 4 contract amendment(codex audit R1)**:per-source `bindSession?(query, ctx)`
可选方法。Source 在 runtime 进入 iterateLocal 前 decorate 一次 query;poppo_http
把 `query.tsMsRange.from = max(provided, ctx.sessionStartMs)` clamp 上来,挡掉
producer retention 留下的前几次 app process 运行的记录。

### Q5+ — 存储

`runDir/evidence/<source.id>/`。Per-source 命名 + `.mtime-cache.json` 与数据同处,
recursive cp / bundle archive 一次抓两半。

### Q5+ — deviceTimezone

`adb shell getprop persist.sys.timezone` 探测,在 `start_session` 完 `getDeviceProps`
后通过 `session.setDeviceTimezone()` 灌入 Session;EvidenceContext.deviceTimezone
向下传给 source。Null 时 source(poppo_http)fail-open:跳过 filename-date filter,
listDeviceFiles 返全集。

### Q6 — redaction

`collect_bundle` 出口 redact:

- Headers(`Authorization`/`Cookie`/`Set-Cookie`/`Set-Cookie2`/`Proxy-Authorization`)
  value → `[REDACTED]`(case-insensitive,request **和** response headers 都过)
- Query params `_sign`/`_random` value → `[REDACTED]`
- URL field reconstruct via WHATWG `URL` + `URLSearchParams`(preserve scheme/port/
  path/duplicate order;placeholder URL-encoded `%5BREDACTED%5D` 保持 url 仍是有效
  URL)
- 其他 field 全 raw

Policy hardcoded in `server/src/profile/poppo-vone/poppo_http/redact.ts`。Future
amendment 下放 profile 是 **v2-G.1 candidate**(触发条件:接入第二 source 且其
敏感字段名 ≠ Poppo)。

**Phase 5 (i) contract amendment(codex audit)**:Q6 redact mandatory at bundle
export;**no opt-out**。`logs:"raw" + acknowledgeUnredacted:true` 只 ack 不 redact
logcat,**不**关闭 evidence redact。Evidence 路径 100% 走 source.redactForBundle。

### Q7 — 工具数

21 → 23:加 `search_evidence` + `extract_evidence_context`。后者镜像 v1
`extract_crash_context` 体例,保留对称感 + future server-side discovery 扩展空间。

### Q8 — extract_evidence_context 输入

- `markerIsoTs: string`(agent 从 events.jsonl ts 直接拷,ISO 8601 含 offset)
- `beforeMs/afterMs`(0-60000,default 5000 each)
- 复用 `search_evidence` 的 discriminated-union query(减 `tsMsRange`)
- handler 拒绝 agent 提供 `query.tsMsRange`(此 tool **拥有**这个字段;agent 同传
  视为 `invalid_argument`)

返回值同 `search_evidence` 加一个 `tsMsRange: {from, to}` echo 字段,让 agent
确认 window 数学。

### Q9 — 持久化(audit trail)

- **events.jsonl**:`{type:"evidence_pulled", source, trigger:"lazy"|"seal", files,
  recordCountDelta?, ts}` —— **只在真实 pull 发生时写**。Cache hit 路径不写 event。
- **commands.jsonl**:每次 `search_evidence` / `extract_evidence_context` 调用都写
  一行 aggregate `{tool, statsRun, pullsTriggered, pulledFiles, ts}`(capture-mirror
  体例)。soft-empty 也写,带 `softEmpty:true + warning`。
- **summary/render.ts**:`describeEvent` 加 `evidence_pulled` + `evidence_seal_failed`
  case;后者 error payload 是 `{code, message}` 结构(Phase 3 audit F amendment;
  legacy string 也兼容渲染)。

### Q10 — profile.json schema

`{ name: string, version: 1 }` minimal,`.strict()` 拒 unknown field。Future
field 走 `version: 2` SemVer bump。

### Q11 — vanilla 项目行为

`search_evidence` / `extract_evidence_context` **永远注册**,tool inventory 23 固定;
无 profile / source 不可达 → **soft-empty + warnings**:

- 无 profile:`{records: [], warnings: ["session has no profile loaded; source 'X' has no provider"]}`
- 源不存在于 profile:`{records: [], warnings: ["profile 'name' has no provider for source 'X'"]}`
- 单次调用还写 commands.jsonl audit row(softEmpty 标记)
- **不**写 evidence_pulled event(没真实 pull)

Hard errors 仅 `profile_malformed` / `profile_unknown`(start_session 路径);
`query_malformed`(source 已知但 query 字段错);`invalid_cursor` / `invalid_argument`
/ `no_active_session`。

### Q12 — implementation plan

5 phase 串行;每 phase codex 双签(pre-impl plan review + post-impl audit)。
最终 cut 0.4.0 tag。详见 [`./v2-g-implementation-plan.md`](./v2-g-implementation-plan.md)。

## Phase 3/4/5 contract amendments(超 Q12)

下列变更是 codex 在 4 轮 plan review + 4 轮 post-impl audit 中提出的,全部 fold-in。

### EvidenceContext 加 `packageName: string`(Phase 4)

Codex audit Phase 4 plan #1。poppo_http 的 device 路径
`/sdcard/Android/data/<pkg>/files/http-logs/` 需要包名;Poppo 与 Vone 共用同一
source impl 但读不同 dir。最干净的注入点是 EvidenceContext,symmetric with
`deviceSerial` / `deviceTimezone`。

### EvidenceSource 加 `bindSession?(query, ctx)`(Phase 4)

Codex Phase 4 plan audit R1。Source 在 runtime iterateLocal 前 decorate query
一次(以 ctx 中的 sessionStartMs / packageName / deviceTimezone 为 input)。
poppo_http 用它把 `query.tsMsRange.from` clamp 到 `ctx.sessionStartMs`,挡掉
producer retention 里前几次 process 运行的记录(否则会"泄漏"过 session 边界)。

Optional;source 不实现就走原 query。

### EvidenceSource 加 `sortKey?(record): readonly (string|number)[]`(Phase 4)

Codex Phase 4 plan audit R2。当 source 声明 sortKey,runtime 切到
**collect → sort → keyset paginate** 路径(替 Phase 3 的 stream file/line cursor);
为满足 schema rev4 § "MCP 消费指南" 的 `(tsMs, runId, seq)` 排序要求。

约束(codex Phase 4 post-impl audit Q):返 tuple 必须 **stable + unique per record**。
runtime 用 `compareSortKeys(rec, cursor.sortKey) > 0` 严格大于做 keyset resume,
两条 sortKey 相同的记录如果横跨 page 边界,后一条会被静默 skip。`poppo_http` 用
`[tsMs, runId, seq]` 满足该约束,`(runId, seq)` 是 schema 的稳定主键。

**Live-evidence caveat**:append-only evidence 上 keyset pagination **不是 snapshot**。
producer 在 page N 之后写入 tsMs < page-N cursor 的记录,page N+1 不会看到。
snapshot 一致性是 `stop_session` seal + `collect_bundle` 的事。

### Cursor 加 `kind` discriminator(Phase 4)

Cursor 现在是:

- `kind:"stream"` —— Phase 3 默认。Cursor 携 `{runId, source, fileKey, lineOffset}`。
  Sources 不声明 sortKey 走这条。Defenses:fileKey basename regex + sourceEvidenceDir
  resolve 防 path-escape + mtime-cache 成员检查。
- `kind:"sort"` —— Phase 4 新增。Cursor 携 `{runId, source, sortKey: (string|number)[]}`。
  Sources 声明 sortKey 走这条。Defenses:tuple primitive-only + length cap 16 +
  element-type 一致性检查。

Cursor codec 在 `server/src/evidence/cursor.ts` 全部 own 校验;source 只贡献
sortKey,不解码 cursor。(Codex Phase 4 plan review α-light pattern。)

### `query_malformed` 新错码(Phase 3)

Surfaced by search_evidence / extract_evidence_context when query 顶层 source 已知
(resolved to a registered EvidenceSource)但 source-specific fields 失败 per-source
strict zod validation。Distinct from `invalid_argument` so agents can branch on
"source is real but my query shape is wrong" vs "missing top-level field".

### `evidence_redaction_unavailable` 新错码(Phase 5 (i))

Surfaced by collect_bundle when evidence on disk cannot be safely redacted —
三种路径:

1. `metadata.profile == null` 但 run 有 `evidence/<id>/` 目录(pre-Phase-3 run
   on a Phase-3+ binary,或手改 run folder)
2. `metadata.profile.name` 不解析(profile 在 binary 更新后被改名 / 删除)
3. Resolved profile 加载 OK 但 `evidence/<id>/` 的 id 是 profile 没声明的 source
   (orphan source from older profile version)

Branchable extras `{profileName: string | null, sourceId?: string}`。这是硬错;
不 silent skip(Q6 要求 mandatory redact at export)。

## Source: poppo_http

reference source for the `poppo-vone` profile。读
`/sdcard/Android/data/<ctx.packageName>/files/http-logs/http_<yyyy-MM-dd>_<idx>.jsonl`,
schema 见 [`../../../submodulepoppo/docs/projects/http-log-jsonl-schema.md`](../../../submodulepoppo/docs/projects/http-log-jsonl-schema.md) rev4(frozen-on-reader-ship)。

### querySchema(public surface)

```ts
z.object({
  source: z.literal("poppo_http"),
  pathPrefix: z.string().min(1).max(1024).optional(),
  methodIn: z.array(z.string().min(1).max(16)).min(1).max(10).optional(),
  outcome: z.enum(["ok", "http_error", "transport_error", "app_error"]).optional(),
  excludeHeartbeat: z.boolean().optional(),      // default false (agent opts IN to filter)
  tsMsRange: z.object({ from: z.number().int().optional(), to: z.number().int().optional() }).strict().optional(),
  hostContains: z.string().min(1).max(255).optional(),
  durationMsGte: z.number().int().min(0).max(60_000).optional(),
  errorTypeIn: z.array(z.string().min(1).max(255)).min(1).max(10).optional(),
}).strict();
```

### outcome cascade(Phase 4 audit R4)

按以下顺序判定;**HTTP 错误优先于 业务错误**:

```
1. error != null                                    → "transport_error"
2. response != null && status ∉ [200,300)            → "http_error"   (即使 app.ok===false 也归这)
3. response != null && app?.ok === false             → "app_error"    (status 在 2xx + 业务说 err)
4. otherwise                                         → "ok"
```

### sortKey

`[tsMs, runId, seq]` —— schema § "MCP 消费指南" reader contract 的排序键。
`(runId, seq)` 是 schema 的稳定主键(producer 进程内 seq 单调),`tsMs` 是主序;
三元组保证 stable + unique。

### bindSession

```
query.tsMsRange.from = max(provided ?? -Inf, ctx.sessionStartMs)
```

Clamps the lower bound 至 session 启动时刻。producer retention(3 天 / 100 MiB)
可能横跨多次 app process 运行;不夹这个 floor,vanilla
`search_evidence({source:"poppo_http"})` 会返出过去 session 的请求。

### Record 不变量

`parsePoppoHttpLine` 在 `.passthrough()` 之上额外 `.superRefine` 强制 3 条 producer
不变量(schema § "不变量",Phase 4 audit V1):

1. `text != null` ⟺ `textBytes != null` ⟺ `omittedReason == null`
2. `preview != null` ⟹ `omittedReason == "oversize"`
3. `preview != null` ⟺ `previewBytes != null`

`omittedReason` / `error.phase` 字段本身是 opaque `string | null`(不 `z.enum`),
但与 preview 联立的 invariant 2 锚定字面值 `"oversize"`;producer 违反就是 contract bug。

## File layout

```
server/src/profile/
├── types.ts                           # EvidenceContext / EvidenceSource / Profile / ProfileJson schema
├── loader.ts                          # loadProfile (start_session 调) + profile_malformed / profile_unknown 错码
├── registry.ts                        # findBuiltinProfile + registerTestProfile/unregisterTestProfile 测试 seam
└── poppo-vone/
    ├── index.ts                       # POPPO_VONE_PROFILE.evidenceSources = [poppoHttpSource]
    └── poppo_http/
        ├── source.ts                  # EvidenceSource 实现
        ├── record.ts                  # zod schema + parsePoppoHttpLine + 3 invariants
        ├── match.ts                   # PoppoHttpQuerySchema + matchPoppoHttpRecord + derivePoppoHttpOutcome
        └── redact.ts                  # Q6 redact policy

server/src/evidence/
├── cursor.ts                          # stream + sort 两个 cursor variant + 5-layer defenses
├── runtime.ts                         # searchEvidence (lazy/seal) + runStreamPath + runSortPath + sealEvidenceSource
├── queryDispatch.ts                   # Q4 dispatch (source 查表 + querySchema strict 校验)
├── mtimeCache.ts                      # readMtimeCache + writeMtimeCache (tmp+rename atomic)
└── paths.ts                           # sourceEvidenceDir / mtimeCachePath helpers

server/src/mcp/tools/
├── search_evidence.ts                 # tool handler + emitPullEventsAndCommand 共享
└── extract_evidence_context.ts        # tool handler (decorates query with tsMsRange)

server/src/bundle/bundle.ts            # redactEvidenceDir(staged, profile) + Q6 enforcement
server/src/mcp/tools/collect_bundle.ts # resolveProfileForRedaction + evidence_redaction_unavailable 错路径

server/src/session/
├── session.ts                         # Session 加 profile / deviceTimezone / evidenceContext() / setDeviceTimezone
├── manager.ts                         # StartSessionInput.profile;pre-create evidence/<id>/ + 失败 cleanup
└── ...
```

## Known 技术债(必须留)

### v2-A `source/recipe.ts` Poppo-bake 未抽离

Phase 1 / v2-A 链 T 的 `BaseBindingActivity<XxxBinding>` 正则 / `binding.<camelEntry>`
代码引用模式 / layout → BindingClass 命名约定 全部 hardcoded。**触发条件**:接入下个月
任意非 Poppo Android 项目时 —— 触发后启动 v2-H(或叫 "SourceProfile extraction"),
把现 `resolveCandidates` 行为 wrap 成 `poppo-vone` profile 的 `SourceResolver`,核心
退到 vanilla(无 profile 时 confidence cap 到 low/medium honest 降级)。

v2-G MVP 跳过它就是为了延迟决策、等真实第二 app 数据进来再 abstract。

### Q6 redaction policy profile-owned(v2-G.1 candidate)

MVP hardcoded list in `poppo_http/redact.ts`。**触发条件**:接入第二 source 且其
敏感字段名 ≠ Poppo 的 `Authorization`/`_sign` 这种;到时候 redact policy 必须
per-source declare(可能作为 EvidenceSource 接口的一部分,或 profile-level 配置)。

### ParsedRecord 在 search_evidence 输出 schema 上仍 open shape

输出仍是 `z.array(z.record(z.string(), z.unknown()))`。Records ARE poppo_http
shape;严格化输出 schema 到具体 source's record 会破坏 Q11 soft-empty 与多源
future。等接入第二 source 时回过头看是否值得做 discriminated output。

### Phase 3 mkdir-cleanup DI test gap

`SessionManager.start` 的 per-source `mkdir` 失败 cleanup path 在代码里 OK,但
regression test 没有(`node:fs/promises.mkdir` 是 frozen ESM export,vi.spyOn
拒绝;pre-place 文件需要预测 runId)。Codex 两次都接受 deferred。Future fix:
test-only DI hook 或 namespace-spyable helper。

## Acceptance scope

8 真机 scenario(profile 加载 happy / profile 损坏 / search happy / extract around
marker / lazy mtime hit / stop seal + bundle redact verify / release build 无
evidence 目录 soft 返 / vanilla 项目工具可见+软返)+ v2-A 70+ vitest 全绿 + 几条
v2-A `tap_node` 真机 sanity(不重跑 5 scenario)。

详细 checklist 见 [`./test-plan-v2g.md`](./test-plan-v2g.md)。

## Release 节奏

hold 0.4.0 tag,phase 5 末统一 cut **`v2-F.0 + v2-G + Poppo HTTP adapter`**(总
23 tool / 3 amendments / 4 lock docs)。详见
[`./v2-g-implementation-plan.md`](./v2-g-implementation-plan.md) § Release。

## 依赖前置

- ✅ Poppo `CustomHttpLoggingInterceptor` 已 land(`rtcrequestlibrary`)+ 设备
  有 `http_*.jsonl`
- ✅ v2-F.0 close sweep land + codex 双签
- ✅ schema doc rev4 措辞 fix(grill 期间 user 自找 — request body 是明文,`text`
  字段说明已修订 in submodulepoppo 仓 unstaged)
