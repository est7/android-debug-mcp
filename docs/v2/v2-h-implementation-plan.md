# v2-H 实施计划 — Evidence Economy & Navigation Timeline

状态:locked(grill 定稿 2026-05-29)。执行者:Codex。本文是 self-contained 执行规格——设计已在 grill 中锁定,实现时**不要重新推导设计**,按本文做。

## 0. 背景与目标(为什么)

真机 e2e 暴露三件事:

1. **token 不经济**:`poppo_http` 默认 preview 仍返回整条 record(满 headers / params / decoded / 1KB body 头),回答「这页走了哪些接口」要几十 k token。
2. **隐私 Blocker**:`request.decoded` 是明文,内含 `imei` / `oaid` / `smei_id` / `appsflyer_id`(真机实测 `9906b772cd3b27a0` 进了「已脱敏」bundle)。`redactPoppoHttpRecord` 只洗 url/params/headers,放过 decoded。
3. **无法归因/无当前页面**:`get_app_state` 只到 Activity;没有「当前 Fragment」;也没有「页面→接口」的时间线关联。

v2-H 三条线一次解决:
- **H1 digest/fields 投影**:默认只回 digest(一行级),按需挂 section;顺带把 decoded 纳入脱敏 + 收紧 `fullRecords`(关 Blocker)。
- **H2 `poppo_nav` EvidenceSource**:与 `poppo_http` 同一个 `poppo-vone` profile、同一套机制,采 app 侧导航面包屑流。
- **H3 多源时间线**:`extract_evidence_context` 收多源,按 `tsMs` 合并 → 「页面→接口」归因。
- **H4 nav producer**:Poppo + Vone app 侧 debug-only 写 `nav-logs`,复用 `HttpJsonlLogger`。
- **H5 真机验收**。

> 性能(jank/meminfo)是另一根独立轴,**不在 v2-H**。

## 1. 执行约定(每个 phase 都遵守)

- **Runner 是 `vitest run`,不是 `bun test`。** 用 `bun run test`(= `vitest run`)。`bun test` 跑 `vi.mock` 会假性失败,不要用它判定绿。
- **TDD**:每个 phase 先写失败测试(RED),再实现(GREEN),最后重跑全部 gate。
- **Gate(每个 phase 收尾全跑,见 memory `verify-all-gates-after-last-edit`)**:`bun run typecheck` → `bun run lint` → `bun run test`,三个都绿才算 phase 完成。
- **Per-phase codex audit gate**(repo 既有约定):每个 phase 实现 + gate 绿后,产出该 phase 的改动摘要供 codex 审,通过再进下一 phase。
- **契约即公共接口**:tool 的 description / inputSchema / 输出 shape / `_meta` 形状都是 public contract;改动在 description 里写清。
- **MCP input 校验**:Zod inputSchema 失败经 SDK 表现为 `{isError:true}`(memory `mcp-sdk-input-validation-surfaces-as-iserror`),不是 throw。
- **不自动 commit**;H4 跨仓(`submodulepoppo` / `submodulevone`,主分支 `development`),每仓出 diff 等人确认。
- 语言:代码/标识符/测试 English;本文 rationale 中文。

## 2. 锁定的设计决策(grill 定稿,实现按此,勿翻案)

- 北极星工作流 = 「页面→接口归因」;A/B/D 共享「围绕 marker 的多源时间线」原语,时间线优先;性能轴(C)押后。
- 时间线行 = **公共信封 + 各 kind digest + ref**;实现上即「多源 digest 按 tsMs 合并」,无需独立 row 类型(digest 已含 `source` + `tsMs`,补 `seq` 即可派生 ref)。
- 时间线交付 = **扩 `extract_evidence_context` 收多源**(evidence sources 合并);logcat / events 暂不进时间线。
- 窗口 = `extract_evidence_context` 保持 60s 上限;「整段停留」走 `search_evidence` + nav 两边界 tsMsRange(无需新窗口语义)。
- `search_evidence` **不**做多源合并(YAGNI)。
- digest 字段:`{ source, tsMs, runId, seq, method, path, host, status, durationMs, outcome, heartBeat, app:{ok,code,message} }`(加 `runId`/`seq`,不加 `pid`)。
- `fields` section 词汇:`request.headers` / `request.params` / `request.body` / `request.decoded` / `response.headers` / `response.body`。
- **脱敏是隐私地板,所有 live 路径统一适用**(digest / fields / `fullRecords`)。`fullRecords:true` 仅解除「截断 + section 裁剪」,**不解除脱敏**(对已文档化契约的有意收紧)。
- decoded = opt-in(`fields:["request.decoded"]` 或 `fullRecords`)+ 递归 key 脱敏(复用 params 同一 key 集)。
- `poppo_nav` source id 用 `poppo_nav`(与 `poppo_http` 命名对齐),但逻辑 Poppo+Vone 共用(同 `poppo-vone` profile,路径走 `ctx.packageName`)。
- nav 可见页判定 = 全局 `FragmentLifecycleCallbacks`(recursive)+「最深 `isResumed && isVisible` 非 Dialog 叶子 fragment」规则。Poppo 主页 `ViewPager` 用 `BEHAVIOR_RESUME_ONLY_CURRENT_FRAGMENT`(`MainActivity.kt:400`),该规则对底栏左右滑即精确,**不碰 MainActivity**。

---

## Phase H1 — `poppo_http` digest/fields 投影 + decoded 脱敏 + `fullRecords` 收紧(MCP 仓)

PUBLIC_IMPACT:改 `search_evidence` / `extract_evidence_context` 默认输出 shape + `fullRecords` 语义。

### H1.1 hook 签名与 runtime 流程

- `server/src/profile/types.ts`
  - 新增 `export interface PreviewOpts { readonly fields?: readonly string[]; readonly fullRecords?: boolean }`。
  - `previewForAgent?(record: ParsedRecord, opts: PreviewOpts): PreviewResult`(加第二参)。
  - `PreviewResult` 加可选:`readonly available?: readonly string[]`(本条存在的 section)、`readonly sizes?: Readonly<Record<string, number>>`(各 section JSON 字节,基于脱敏后记录)。
- `server/src/evidence/runtime.ts`
  - 当前 `fullRecords:true` **跳过** preview。改为:**只要 source 声明了 `previewForAgent` 就总是调用它**,把 `{ fields, fullRecords }` 透传进去;由 source 决定形状。`fullRecords` 不再是「跳过 preview」而是「preview 的一个 opt」。
  - `searchEvidence(...)` 入参增加 `fields?: readonly string[]`,透传到 `applyPostPageTransform` → `previewForAgent`。
  - runtime 把 `result.available` / `result.sizes` 一并挂进 `_meta.preview`(与现有 `truncated/truncatedFields/redactedFields/fullSizeBytes` 同级)。
- 同步更新所有实现了 `previewForAgent` 的测试 fake source 的签名。

### H1.2 decoded 递归脱敏(关 Blocker)

- `server/src/profile/poppo-vone/poppo_http/redact.ts`
  - 新增递归函数:遍历任意 JSON 值,对象 key 的 `toLowerCase()` ∈ `SENSITIVE_QUERY_NAMES_LC` 时,value 整体替换为 `REDACTED_PLACEHOLDER`;数组/嵌套对象递归。
  - 在 `redactPoppoHttpRecord` 中对 `request.decoded` 应用该函数(decoded 可能是 object / array / 标量 / null)。
  - 复用既有 `SENSITIVE_QUERY_NAMES_LC`(已含 `_sign/_random/_uid/uid/smei_id/uuid/device_id/imei/oaid/idfa/appsflyer_id`)。

### H1.3 投影实现(重写 `preview.ts`)

`previewPoppoHttpRecord(record, opts)`:

1. `redacted = redactPoppoHttpRecord(record)`(已含 decoded)。
2. `fullSizeBytes = Buffer.byteLength(JSON.stringify(record))`(原始未脱敏 record 的尺寸,口径不变)。
3. 计算 `available` + `sizes`(基于 `redacted`):`request.headers` / `request.params` / `request.body`(body 有内容时)/ `request.decoded`(decoded 非 null)/ `response.headers` / `response.body`(response 非 null)。`sizes[section] = Buffer.byteLength(JSON.stringify(<该 section 值>))`。
4. **digest**(始终构造):`{ source:"poppo_http", tsMs, runId, seq, method, path, host, status: response?.status ?? null, durationMs, outcome: derivePoppoHttpOutcome(record), heartBeat, app: response?.app ? {ok, code, message} : null }`。
   - `derivePoppoHttpOutcome` 在 `match.ts`,export 出来复用。
5. 分支:
   - `fullRecords === true`:`out = redacted`(全 section,body **不截断**)。`truncated=false`,`truncatedFields=[]`,`redactedFields=<脱敏改动的 paths>`。
   - 否则:`out = { ...digest }`,对 `fields ?? []` 中每个已知 section,从 `redacted` 取该 section 挂到 `out`(body section 走现有 1KB 截断逻辑;`request.decoded` 直接挂脱敏后的 decoded)。未知 section 名忽略。`truncatedFields` = 被截断的 body section;`redactedFields` = 已挂 section 中被脱敏的 paths。
6. 返回 `{ record: out, truncated, fullSizeBytes, truncatedFields, redactedFields, available, sizes }`。

> `computePreviewAudit`(search_evidence.ts)语义不变:只统计 `truncated:true`。digest-only(无截断)的记录 `truncated=false`,不进字节账本。

### H1.4 两个工具加 `fields`

- `server/src/mcp/tools/search_evidence.ts` 与 `extract_evidence_context.ts`:
  - inputSchema 加 `fields: z.array(z.string().min(1).max(64)).max(16).optional()`。
  - 透传到 `searchEvidence(...)` 的 `fields`。
  - description 更新:`Args` 增 `fields`(默认 digest;可挂 `request.headers|request.params|request.body|request.decoded|response.headers|response.body`);`Returns` 写明默认 digest + `_meta.preview.{available,sizes}`;`fullRecords` 改述为「全 section + body 不截断,**仍脱敏**」(去掉「raw」字样)。

### H1.5 文档

- `docs/v2/preview-for-agent.md`:更新 `PreviewResult`(加 `available/sizes`)、`previewForAgent` 签名、digest 默认、`fields` 词汇、`fullRecords` 收紧后的语义、decoded opt-in+脱敏。

### H1.6 测试(RED→GREEN)

`tests/profile/poppo-vone/poppo_http/preview.test.ts` + `redact.test.ts` + `tests/mcp/search_evidence.test.ts`:

1. digest 默认:返回 record 仅含 digest 字段,**无** request/response 的 headers/params/body/decoded;`_meta.preview.available` 列出存在 section;`sizes` 有值;`truncated:false`。
2. `fields:["response.body"]`:digest + response.body(大 body 截断 1KB);其它 section 仍缺席。
3. `fields:["request.decoded"]`:decoded 在,但 `imei/oaid/smei_id/appsflyer_id/_uid/uuid` = `[REDACTED]`;`os_version/b_vpn` 等业务字段保留。
4. `fullRecords:true`:全 section、body 不截断,**但** `_sign/imei/Set-Cookie` 仍 `[REDACTED]`(收紧断言)。
5. redact 单测:decoded(object 含上述敏感 key + 嵌套)→ 敏感 key 值打码、其余原样;decoded 为标量/null 不炸。
6. `_meta.preview.available/sizes` 正确性。
7. `extract_evidence_context` 透传 `fields`。
8. 既有 byte-ledger / redactedFields 分离断言仍绿。

### H1.7 Gate + audit
`bun run typecheck && bun run lint && bun run test` 全绿 → 出改动摘要供 codex 审。

---

## Phase H2 — `poppo_nav` EvidenceSource(MCP 仓)

新增 `server/src/profile/poppo-vone/poppo_nav/`,与 `poppo_http` 同 profile。

### H2.1 record.ts
- 设备记录 schema(`.passthrough()`,容忍未知字段):`{ v?: 1, tsMs: int, type: "activity"|"fragment"(string,opaque), name: string, host?: string }`。
- `parsePoppoNavLine(line): ParsedRecord | null`,stamp `source:"poppo_nav"`,parse 失败返 null(不抛)。

### H2.2 source.ts(`EvidenceSource`)
- `id = "poppo_nav"`。
- `deviceDir = /sdcard/Android/data/<ctx.packageName>/files/nav-logs`;`FILENAME_PATTERN = /^nav_(\d{4}-\d{2}-\d{2})_(\d+)\.jsonl$/`;复用 `poppo_http` 的 `shouldKeepByFilenameDate` / `listDeviceFiles` / `pullFile` 同款实现(可抽共用 helper,亦可复制——优先抽小 helper 避免漂移)。
- `querySchema`(`.strict()`,`source: z.literal("poppo_nav")`):`{ source, tsMsRange?{from,to}, typeIn?: string[], nameContains?: string }`。
- `matchQuery`:tsMsRange + typeIn + nameContains(大小写不敏感子串)。
- `bindSession`:同 `poppo_http`——有 `tsMsRange` 时 `from = max(from, ctx.sessionStartMs)`,无则原样。
- `validateNarrowingFilter`:**不设**(nav 数据量小,无 fetch-all 风险)。
- `redactForBundle`:identity(nav 只有类名,无 PII)。
- `previewForAgent(record, opts)`:nav 记录本就极小 → digest = 整条 record;`available=[]`,`sizes={}`,`truncated=false`,`truncatedFields=[]`。`opts.fields` 忽略。
- `sortKey`:**不实现**(走 streaming path;跨源合并在 H3 的工具层按 tsMs 做)。

### H2.3 注册
- `server/src/profile/poppo-vone/index.ts`:`evidenceSources` 数组加入 `poppoNavSource`。

### H2.4 测试
`tests/profile/poppo-vone/poppo_nav/*.test.ts`:parse happy/null、match(tsMsRange/typeIn/nameContains)、bindSession floor、bundle redact = identity、preview digest = 整条、profile 注册后 `search_evidence({source:"poppo_nav"})` 可达 + soft-empty(无 nav 文件)。

### H2.5 Gate + audit(同 H1.7)

---

## Phase H3 — `extract_evidence_context` 多源合并(MCP 仓)

### H3.1 入参
- 加 `sources?: Array<{ source: string } & Record<string, unknown>>`(每个元素是一个 source-specific query,不含 `tsMsRange`——工具按 marker 注入)。
- 保留既有单 `query`(向后兼容)。`query` 与 `sources` 互斥:都给 → `query_malformed`;都不给 → `query_malformed`。

### H3.2 行为
- 对 `sources` 每个 query:跑现有单源窗口逻辑(marker ± before/after 注入 tsMsRange → dispatch → search → 各源 `previewForAgent`(digest 默认))。
- 把各源结果 records **按 `tsMs` 升序合并**为一个 `records[]`(每条是该源 digest,已带 `source` + `tsMs` + `seq`/标识 → ref 可派生)。`limit` 作用于合并后列表。
- 多源模式 `nextCursor` 复杂度高:**v2-H 不做多源分页**,合并后超 `limit` 直接截断并在 `warnings` 里说明「multi-source truncated at limit; narrow ts/sources」(no silent cap)。单源 `query` 路径分页不变。
- 输出仍是 `{ records, warnings?, statsRun, tsMsRange }`;`statsRun` 各源累加。

### H3.3 description
- 写明:`sources` = 多源时间线;返回按 tsMs 合并的 digest 序列;logcat/events 不在内;多源不分页(超 limit 截断 + warning)。

### H3.4 测试
`tests/mcp/search_evidence.test.ts`(或新 file):
- fixture:同窗口内 nav + http 记录交错 → `sources:[{source:"poppo_nav"},{source:"poppo_http",pathPrefix:"/"}]` → 返回按 tsMs 升序、含两个 source 的 digest。
- `query` 与 `sources` 互斥的两个 `query_malformed`。
- 多源超 limit → 截断 + warning。
- 各源 tsMsRange 注入正确(marker ± window)。

### H3.5 Gate + audit

---

## Phase H4 — nav producer(`debuglibrary`,debug-only,跨仓)

> 进入 app 仓即以该仓 `CLAUDE.md` 为准;主分支 `development`;**不自动 commit**,每仓出 diff。
>
> **家定在 `debuglibrary`,不是 `rtcrequestlibrary`。** 理由(已查证):
> - rtcrequestlibrary 是 HTTP 层,记导航生命周期是职责错位(用户否决)。
> - `debuglibrary` 经 `basefunlibrary/build.gradle:137` 的 `debugImplementation project(':debuglibrary')` 进 app → **整模块 debug-only**,nav 自动只在 debug 构建存在(无需运行时 flag,无 AAR/release-DEBUG 坑)。
> - `debuglibrary/.../ToolContentProvider.kt` 已用 ContentProvider 自启 + `registerActivityLifecycleCallbacks`(给 Activity 挂 ToolView)——debug 观测的现成宿主,职责正确。
> - Poppo / Vone 的 debuglibrary **两仓同源**(`ToolContentProvider.kt` 字节一致,均为 source 非 AAR)→ Poppo 改完同步到 Vone,**无 AAR 重发**。
> - 因此 **不碰 `rtcrequestlibrary`**(连 HttpJsonlLogger 都不动)。

### H4.1 自包含 nav JSONL writer(debuglibrary 内)
- 在 `debuglibrary` 新增一个小 writer,**复刻** `rtcrequestlibrary/HttpJsonlLogger` 的生命周期纪律(队列 + IO 协程 + writeLock + shutdown hook + 滚动/保留),**复制而非依赖**——HttpJsonlLogger 注释自述「跨模块抽共用基类不值当」,且让 debuglibrary 依赖 rtcrequestlibrary 只为一个文件写入器也是错耦合。
- 文件名前缀 `nav_`,`navDir = File(context.getExternalFilesDir(null), "nav-logs")`(= `/sdcard/Android/data/<pkg>/files/nav-logs`,对齐 MCP `poppo_nav`)。
- API:`record(type: String, name: String, host: String? = null)` → 入队一行 JSON `{tsMs: System.currentTimeMillis(), type, name, host?}`。

### H4.2 nav lifecycle tracker(debuglibrary 内,复用既有自启)
- 在 `ToolContentProvider.onCreate`(或同模块 sibling)中,**仅在主进程**(查进程名,跳过 :ipc / 融云等子进程,避免多 writer 重复写)注册:
  - `registerActivityLifecycleCallbacks`:`onActivityResumed` → `record("activity", activity::class.simpleName)`;`onActivityCreated` 对 `FragmentActivity` `supportFragmentManager.registerFragmentLifecycleCallbacks(fcb, /*recursive=*/true)`。
  - `fcb`:`onFragmentResumed` / `onFragmentPaused` 后,算当前 **最深 `isResumed && isVisible` 且非 `DialogFragment`** 的叶子 fragment;与上次不同才 `record("fragment", leaf::class.simpleName)`(去抖)。
  - rationale:Poppo 主页 `ViewPager` 用 `BEHAVIOR_RESUME_ONLY_CURRENT_FRAGMENT`(`MainActivity.kt:400`),只有可见页 RESUMED,该规则对底栏左右滑即精确;vp2 同理(`setMaxLifecycle`)。
- 不引用 Firebase;不碰任何业务 Activity/Fragment。

### H4.3 Vone 同步
- Poppo `debuglibrary` 改完 → 同步到 `submodulevone/debuglibrary`(两仓本字节一致)。两仓各出 diff,**不自动 commit**。无 AAR 重发。

### H4.4 验证(无自动化测试,真机手验)
- 装 debug 包,底栏切 5 个 tab + 进二级页 → `ls /sdcard/Android/data/<pkg>/files/nav-logs/` 有 `nav_*.jsonl`,内容为可见页类名序列、tsMs 与 http 同口径(epoch ms);多进程下只主进程写。

---

## Phase H5 — 真机端到端验收

- 扩 `server/tests/e2e/real_device_sweep.test.ts`(opt-in,`ANDROID_DEBUG_E2E=1`):
  - 「当前页面」= `search_evidence({source:"poppo_nav"})` 取最新一条 = 实际可见 fragment。
  - 「页面→接口」= 取某 nav 记录 tsMs → `extract_evidence_context(sources:[{poppo_nav},{poppo_http,pathPrefix:/}])` → 合并时间线里 nav 行后跟随该页 http。
  - digest token 验证:同一 pathPrefix 查询,digest 默认体积 << `fullRecords`。
  - 隐私验证:digest 默认不含 `imei/oaid/smei_id`;`fields:["request.decoded"]` 下这些 = `[REDACTED]`、业务字段在;`fullRecords` 下 `_sign/imei/Set-Cookie` 仍 `[REDACTED]`;`assertNoLeakedSecrets` 扩到扫 decoded 里的裸 `imei/oaid/smei_id` 值。
- 真机一轮手验,物证落 `docs/v2/test-plan-v2h.md`(新建,对标 `test-plan-v2g-evidence.md` 体例)。

---

## 依赖与顺序

H1 → H2 → H3 全在 MCP 仓、hermetic,可顺序 TDD。H4 跨仓、debug 包,需真机;H3 的多源时间线测试可先用 nav fixture 不依赖 H4。H5 依赖 H4 装包后真机。

## 不在范围(v2-H 明确不做)
- 性能轴:`dumpsys gfxinfo`(jank)/ `meminfo`(内存)/ 启动耗时——独立 feature。
- WS/RTC(融云)证据源——后续按需,同 producer 模式。
- 业务状态面包屑(登录/房间)——后续。
- `search_evidence` 多源合并;`extract_evidence_context` 多源分页;logcat/events 进时间线——按需再开。
- API path→源码、log→源码映射——后续。
