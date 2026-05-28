# Android Debug MCP — v2-G.1 Design Lock · Agent-facing record preview + tsMsRange 收紧

**Locked: 2026-05-28**(codex pre-impl plan review 4 rounds: STOP × 3 → GO at
round 4 final verify `2026-05-28T03-18-43.332Z` thread `review/v2-g1-preview-for-agent`)。
Drafted 2026-05-27 v0.5.0 cut 之后,作为 v0.6.0 sprint Tier 1 第一件。

Grill 进度:
- **Round 1**(2026-05-27,codex STOP) — 5 条 blocking + 3 条 advisory + 6 条
  open-question 答案,**全部 fold-in 完毕**;详见 § Amendments § "Round 1"。
- **Round 2**(2026-05-28,codex narrow STOP) — 3 条 contract-text 矛盾
  (`_meta` 全局 reservation vs preview-branch 局部检测 / 顶层 cap 描述 /
  Q1 fallback wording)+ 1 条 advisory(stale pointer),**全部 fold-in 完毕**;
  详见 § Amendments § "Round 2"。
- **Round 3**(2026-05-28,codex narrow STOP) — 3 条 stale-text 残留(Baked 假设
  #4 的 "per-source 可降" / Q3 末 phase 标 Phase 2 与 Q12 Phase 1 矛盾 /
  Q12 Phase 4 仍写 "8 scenarios" 但 Acceptance 已 10),**全部 fold-in 完毕**;
  详见 § Amendments § "Round 3"。
- **Round 4**(2026-05-28,codex **GO**) — final verify 通过,所有 5 条验证点
  (Baked #4 / `_meta` phase ownership / Acceptance count / Q1-Q11 metadata
  semantics / `_meta` collision coverage)一致;1 条 advisory(Phase 1 title
  "types only" → "types + runtime invariant plumbing")应用。
- 设计 lock now Locked;Phase 1 implementation 启动。

Promoted from [`../backlog.md`](../backlog.md) § v2-G "Agent-facing per-record
preview / truncation" 与同段 "Block A 软 bypass:`tsMsRange:{from:0}`" 两条
技术债 —— 这两件事 v0.4.0 audit 时一起记账,本 sprint 一起做(共用一次 codex 轮)。

## 文档定位

v2-G.1 = **agent-facing read 工具的"单条 record 体积 + 时间窗形态"两项收紧**。
v0.4.0 Block A 治"调用频次"(`validateNarrowingFilter`),Block B 治"单次响应
体积"。两条同根:agent 不应有 fetch-all 能力 ——
[`profile-and-evidence.md`](./profile-and-evidence.md) § "EvidenceSource 加
`validateNarrowingFilter?`" Block A 已经把"无 filter 一把捞"堵了;**单条**记录
撑爆 context window 是同一漏洞的另一面(Poppo `lang.json` 实测 ~622 KB / 单条
≈ 155k tokens,等于把 Claude 1M context 的 15% 在 1 条 record 上烧掉)。

v2-G.1 ships 两个独立但同根的改动:

- **Block B(preview):** `EvidenceSource` 增加 `previewForAgent?(record)` 钩子;
  `search_evidence` / `extract_evidence_context` 默认走 preview,新增
  `fullRecords?: boolean` 让 agent 显式付代价。
- **Block A 收紧(tsMsRange):** `tsMsRange` 在 `search_evidence` 进入条件下
  强制 `from` + `to` 双 bounded;`poppo_http` 本 sprint **hardcode 24h cap in
  `match.ts`**(source-declared `evidenceWindowCapMs?` interface 是 future v2-G.X,
  触发条件 = 接入第二 source 且其窗口需求不同);`narrowingFilter` 不再接受
  `{from: 0}` 之类"软 bypass"。

**不引入** 新 tool。**不动** v2-F / v2-A / v2-G v0.4.0 已 lock 的契约;只在
`EvidenceSource` interface 加一个 optional 方法 + 两个 read tool 各扩 1 个 input
字段 + tsMsRange schema 收紧。

体例对齐 [`./profile-and-evidence.md`](./profile-and-evidence.md) §
"Phase 3/4/5 contract amendments";v2-G v0.4.0 / v0.4.1 / v0.5.0 的契约不动,
本文件仅锁 v0.5.1 在它们之上**新增 + 收紧**的部分。

## Baked-in assumptions(不上桌的前提)

1. **Preview 是 agent-facing only**(`search_evidence` / `extract_evidence_context`)。
   `collect_bundle` **不走** preview —— bundle 是离线分析素材,redaction 走
   `redactForBundle`,preview 不参与;两路径独立。
2. **Preview 是 lossy by design**。Agent 收到 preview 时**知道**有截断 ——
   服务端通过显式字段告诉 agent 完整 size 与截断比例;agent 想要全文必须显式
   `fullRecords: true` 付代价。
3. **截断策略是 source-owned**(同 `redactForBundle` / `sortKey` 的体例)。
   每个 source 自决要 truncate 哪些字段、阈值多大;runtime 不强加一个 "对所有
   source 字段做 N 字节首部截断"的模板,因为 record shape 由 source 定义。
4. **Block A 收紧不是 breaking change for `extract_evidence_context`**。它内部
   `tsMsRange.from = marker - beforeMs` / `to = marker + afterMs`,本来就是
   双 bounded;`poppo_http` 本 sprint hardcode 24h cap in `match.ts`,对 extract
   的 60 s window 是 no-op。(source-declared cap 是 future v2-G.X candidate;
   不在本 sprint 范围内 —— 与 Block A 顶层 summary + Q8 一致。)
5. **Source 不实现 `previewForAgent?` 时,fallback 是返 raw record(等价 fullRecords:true)**。
   保 Q11 vanilla-soft-empty 与 future source onboarding 都不挂在这个 hook 上 ——
   sources 可以渐进迁移。
6. **`fullRecords:true` 不绕过 narrowingFilter / window cap / pagination**。Agent
   付的是"单条返完整",不付"一次返全 session"。limit / cursor / window 都还作数。

## 决策表(Q1–Q12)

### A. previewForAgent contract 形态

#### Q1:hook 放在 `EvidenceSource` 接口,还是 runtime / tool 层的通用 transform?

**Decision: 放在 `EvidenceSource`,以 optional method `previewForAgent?(record): PreviewResult` 暴露。**

理由(每条都是反方向被否决的命题):

- runtime / tool 层通用 transform 要求"截哪些字段"是 schema-agnostic 的元规则,
  但 record 形态由 source 定义 —— Poppo HTTP record 的 `body.text` / `body.decoded` /
  `request.body.text` 是 oversize hotspot,但下一个 source(比如 v3-A sidekick
  event)的 hotspot 是别的字段。一个 "字段名首字母大写就截"之类的通用规则不存在;
  字段语义只有 source impl 自己知道。
- 跟现有 `redactForBundle` / `sortKey` / `bindSession` / `validateNarrowingFilter`
  同体例 —— source 持有"如何 mutate 它自己 record"的全部 policy。runtime 只调
  方法、不知细节。
- Optional:source 不实现 → **raw passthrough,不注入 `_meta.preview`** —— agent
  从 `_meta` 缺席判断"这个 source 不支持 preview"(Round 2 amendment;与 Q11
  三栏表对齐;`truncated:false` 只用于 hook 声明且本条不达阈值的情形)。
  Phase 3 vanilla soft-empty 不破。

#### Q2:hook 签名与返回形状

**Decision:**

```ts
interface PreviewResult {
  /** Truncated record. Shape MUST be the same `ParsedRecord` subtype as
   *  the input — agents downcast by `source` field as today.            */
  readonly record: ParsedRecord;
  /** True iff `record` differs from the input in some lossy way.        */
  readonly truncated: boolean;
  /** Raw input record's serialized-as-utf8-JSON byte size (≈ token cost
   *  shorthand).  Used by agent to decide whether to re-fetch with
   *  `fullRecords:true`.                                                 */
  readonly fullSizeBytes: number;
}

interface EvidenceSource {
  // ... existing fields
  previewForAgent?(record: ParsedRecord): PreviewResult;
}
```

理由:

- 不返 wrapper / 不返 envelope:runtime 把 `result.record` 直接塞回 `records[]`
  数组,**record 形态保持稳定**;truncation metadata 走 record root 的 `_meta.preview`
  字段(见 Q3,Round 1 amendment),agent 通过 schema 已知字段拿到,不需要解 wrapper。
- `fullSizeBytes` 用 raw JSON utf8 byte 长度,**不是** 截断后体积。Agent 决策
  "要不要付 full" 用的是 raw size。
- `truncated` 与 `fullSizeBytes` 都从 hook 返,而不是 runtime 计算 ——
  实现可以避免重序列化(`JSON.stringify(record)` 在大 record 上自身就吃 ms),
  source 可以在生成 preview 同时手算 `fullSizeBytes`(对 Poppo HTTP record 来说,
  `body.textBytes + body.decoded 序列化 size + 其它字段 size` 已知或廉价)。

#### Q3:截断 metadata 落在 record 哪里?

**Decision:record 根级注入 `_meta.preview` 嵌套结构,`_meta` 是
server-owned 命名空间。**

```ts
type RecordWithMeta = ParsedRecord & {
  readonly _meta?: {
    readonly preview?: {
      readonly truncated: boolean;
      readonly fullSizeBytes: number;
      /** Field paths that were lossily mutated. Example for poppo_http:
       *   ["response.body.text", "response.body.decoded", "request.body.text"]
       *  Empty array when truncated:false.                          */
      readonly truncatedFields: readonly string[];
    };
    // Future server-injected metadata (e.g. _meta.redaction, _meta.cached)
    // lives under same namespace; no shape migration needed at that point.
  };
};
```

理由:

- 不放 envelope:`records: [{record, preview}]` 形态破 v0.4.0 已 lock 的输出
  schema(`z.array(z.record(z.string(), z.unknown()))`),所有现有 caller 都得改。
  注入字段是 in-shape 扩展,output schema 不动。
- `_meta` 是 server-injected 元命名空间,**source.parseLine 产出 record 不允许
  包含 `_meta` key**(runtime pre-projection invariant —— 见 § Q5b 的 invariant
  #6;实施位置见 § Q12 Phase 1);跟 `source` 字段同体例(`source` 也是 runtime
  stamp,record.ts 没 producer 一面)。
- `truncatedFields[]` 让 agent 看到"哪几个字段被砍了" —— Poppo HTTP record
  body 有两面(`request.body` / `response.body`),还有 `decoded`;告诉 agent 哪面
  被砍能让它精确决策(只想看 response body 就 full-fetch 一次)。
- `fullRecords:true` 路径 record 上**不出现** `_meta.preview`(完整记录没有
  截断 metadata 可言)。若 source 不实现 `previewForAgent?` hook,record 上
  也**不出现** `_meta`(等价 raw passthrough)。

**Round 1 amendment(codex STOP 2026-05-27 #5 + 开放问题 #1):**Q3 原文用 flat
`_preview` 字段,理由是 YAGNI(只有一类 server-injected metadata)。codex 反对论据:
`ParsedRecord` 在 `server/src/profile/types.ts:81-84` 是 open index shape,future
source 可能误产出 `_preview` key,runtime 静默 overwrite / collide 无报警;一旦再
要 `_meta.redaction` / `_meta.cached` 等元字段,会被迫做 shape migration。最终落点:
现在就开 `_meta.preview` 命名空间,**runtime pre-projection invariant 检测
`record._meta !== undefined` 并 throw**(实施位置 Phase 1 —— 与 types.ts 加
hook 接口同 phase 落地;Round 2 amendment 把检测从 preview 分支拔成全局
invariant,详见 § Q5b)。Collision 在测试中显式断言(见 § Acceptance 新增
scenario #10)。同一轮 amendment 调整开放问题 #1 答案为 nodded with `_meta.preview`。

#### Q4:Poppo HTTP source 的 preview 策略

**Decision:对 `request.body` 与 `response.body` 各执行如下规则,其它字段保持不变。**

```
若 body.text != null 且 body.textBytes > THRESHOLD_BODY_TEXT_BYTES (2048):
    body.text     ← body.text 头 1024 chars + " …<truncated N bytes>"
    body.textBytes 保留原值       (agent 算 full size 用)
    truncatedFields += "<which>.body.text"

若 body.decoded 不为 null:
    serialized = JSON.stringify(body.decoded)
    若 serialized.length > THRESHOLD_BODY_DECODED_BYTES (2048):
        body.decoded ← { __truncated: true, headChars: serialized.slice(0, 1024), fullBytes: serialized.length }
        truncatedFields += "<which>.body.decoded"

(`request.body` 与 `response.body` 同样规则各跑一次;`response.body` 不存在时
 跳过 —— `error != null` 分支。)

fullSizeBytes = JSON.stringify(originalRecord) 的 utf8 字节长度
                (Bun: Buffer.byteLength(JSON.stringify(record), 'utf8'))
```

理由:

- `body.text` / `body.decoded` 是 record 90%+ 体积来源(其它字段 - 元数据 -
  headers - 都是百字节量级)。砍这两块即可把单条 ~622 KB 压到 < 10 KB。
- 头 1024 chars 是体积与可读性的平衡 ——
  - JSON 错误一般在前几行(parse error / 字段名错);
  - HTML 错误页头有 `<title>`;
  - Poppo `lang.json` 头是 `{"login":"登录","cancel":"取消",...`,前 1024 字符就
    够 agent 识别 key 模式。
- 阈值 2048 字节(≈ 500 tokens):低于该值的 body 留全文 —— record 不大就别多事。
- **不动 `body.preview` / `body.previewBytes` / `body.omittedReason`** —— 这些是
  producer 侧的 oversize marker,语义独立。Agent preview 的截断信号走 `_meta.preview`
  根级元字段(Round 1 amendment),不污染 producer-defined invariants。
- `JSON.stringify(record)` 跑一次拿 `fullSizeBytes` —— O(record size) 但
  Poppo 单 record 最大 ~622 KB,Bun JIT-warm 后 < 5 ms,可接受。Future
  optimization:source 自己累加(textBytes + decoded serialized length +
  estimated rest)直接给值,不再调 `JSON.stringify`。

#### Q5:阈值 / 截断字符数 是 hardcoded 还是 source-declared 还是 server-side env?

**Decision:hardcoded in source impl(`poppo_http/preview.ts` 新模块)。**

理由:

- v2-G MVP 一贯做法:`derivePoppoHttpOutcome` cascade / `validateNarrowingFilter`
  字段集 / `redactForBundle` policy —— 全是 hardcoded in poppo_http。下放到
  profile-level config 是 v2-G.X candidate(同 Q6 redact policy 的触发条件:
  接入第二 source 且其阈值需求不同)。
- 不走 server env:env-tunable 阈值会让"agent 行为依赖部署环境"—— 同一 record
  在两台机器上 agent 看到不同截断结果,debug 时 reproducibility 崩溃。
- 阈值若太松/太紧,改 `poppo_http/preview.ts` 即可,impact 局部。

#### Q5b:runtime preview 调用点 + invariants(Round 1 新增)

**Decision:`previewForAgent` 在 stream / sort 两条 page 路径**完结后、handler 拼
response 之前**统一调用 —— page-slice-after,**纯 read-time projection**。**

```
searchEvidence(input) →
   ↓ syncDevicePulls (mtime cache diff + adb pull)
   ↓ bindSession decorate (effective query)
   ↓ if source.sortKey: runSortPath → collect-all → sort → keyset slice → pageRecords
        else:            runStreamPath → file/line cursor iterate → pageRecords
   ↓ pre-projection invariant (Round 2 amendment):
        for r in pageRecords:                    // ALL records, regardless of preview path
            if r._meta !== undefined:
                throw <_meta-collision error: source produced reserved key>
   ↓ projection transform (Round 1 new):
        if source.previewForAgent && !input.fullRecords:
            for r in pageRecords:
                pr = source.previewForAgent(r)
                pageRecords[i] = { ...pr.record, _meta: { preview: {truncated, fullSizeBytes, truncatedFields} } }
        // else: fullRecords:true OR source has no previewForAgent → pageRecords unchanged
        //       (raw passthrough; _meta absent because pre-projection guard verified it)
   ↓ return { records: pageRecords, nextCursor, pulls, statsRun }
```

**Invariants(codex Round 1 STOP 要求显式 lock):**

1. **`previewForAgent` MUST NOT affect `matchQuery`** —— preview 在 match 之后跑,
   不影响哪条 record 入 page。
2. **MUST NOT affect `sortKey`** —— preview 在 sort 之后跑,排序键基于 raw record。
3. **MUST NOT affect cursor encoding** —— stream cursor 的 `lineOffset` 与 sort
   cursor 的 `sortKey` 都基于 raw 数据,preview 不变更游标语义。
4. **MUST NOT affect `recordsScanned`** —— `recordsScanned` 是"扫了多少条 raw
   line",preview 是 page-cap 后的小子集 transform,不计入 scan 统计。
5. **MUST NOT affect `nextCursor`** —— pagination 决策只看 raw match + raw page
   slice + raw `next` (stream) / raw `lastInPage` (sort)。
6. **`_meta` is a globally reserved key on `ParsedRecord`**(Round 2 amendment)——
   `source.parseLine` 任何路径下产出含 `_meta` 字段的 record,**runtime 在
   page slice 之后、preview projection 之前一律 throw**;此检查与 preview
   是否启用、`fullRecords:true` 与否、source 是否声明 `previewForAgent` 全部
   解耦。理由:`_meta` 是 server-injected metadata 命名空间(Q3),全局约束;
   把 collision 检测局限在 preview 分支会让 `fullRecords:true` 与 no-hook
   source 上的 `_meta` 字段静默穿过,违反 Q3 锁定的全局不变量。

理由:preview 是 read-time agent-facing 投影,与 runtime 的"找哪些 record / 怎么
排序 / 怎么 page"语义完全正交;一旦混入这些 hot path,sort 与 stream 两条码路
的 cursor 不变量会被打破,带 cursor 的下页 fetch 结果会与首页结果不一致。
Round 1 codex 直接给出"page-slice-after invariant lock",本草此前未明示;同段
新增以闭合 contract。

**Round 1 amendment(codex STOP 2026-05-27 + 开放问题 #4):**Q5b 是 Round 1
新增的小节。Page-slice-after 调用点本来就是默认草中的方向,但 5 条 invariant
未在 lock 上显式;codex 要求 explicit lock 防 future 误改。Acceptance scenarios
#9 / #10 + 通用 `runtime.test.ts` 同步加 invariant 回归测试。

**Round 2 amendment(codex STOP 2026-05-28 #1):** 原 Q5b 把 `_meta` collision 检测
写在 `if source.previewForAgent && !input.fullRecords` 分支内,等价于
"`fullRecords:true` 或 no-hook source 路径上,source 产出 `_meta` 静默穿过";
codex 抓为违反 Q3 的全局约束(Q3 明示 `_meta` 是 server-owned 命名空间,
source.parseLine 全局禁止产出)。最终落点:**collision 检测拔到 pre-projection
单独 invariant 一步**,对所有 pageRecords 跑(包括 fullRecords:true / no-hook
两条 bypass-shape 路径)。Acceptance #10 同步扩两条 case(preview 路径 + bypass-shape
路径各一)。

### B. Tool 边界变化

#### Q6:`search_evidence` / `extract_evidence_context` 的 `fullRecords` 参数

**Decision:两 tool 各扩 `fullRecords?: boolean`(default `false`)。`true` 时
跳过 `previewForAgent` 调用,record 原样返。**

```ts
// inputSchema 增量(strict 仍保):
fullRecords: z.boolean().default(false).optional()
```

- 默认 `false` —— 沿用"agent 默认拿便宜的、显式付代价拿贵的"原则。
- `true` 时仍受 `limit` / `cursor` / narrowingFilter / window cap 全部 gate
  约束(详见 Q8 关于 limit 的额外 cap)。

#### Q7:`fullRecords:true` 时 `limit` 是否额外收紧?

**Decision(Round 1 修订):`fullRecords:true` 时 `limit > MAX_FULL_LIMIT (10)` →
直接 reject 为 `query_malformed`,error message 明示
"`fullRecords:true` requires `limit <= 10`; for more, paginate with `cursor`"。**
**不** silent clamp,**不** 加 envelope-level `clampedLimit` 字段。

理由:

- 单条 622 KB × 100 = 60 MB response payload,即便 agent 显式付,MCP 通讯本身
  撑不住(MCP SDK 也有 response size limit;实际跑会 transport-layer fail)。
- 10 条上限对应 ~6.2 MB / 单次,单次 IO 量级可控;agent 真要看 100 条 full
  record 走 pagination(10 次 round-trip),自然分散到 10 个 turn。
- reject vs clamp 的最终选择(Round 1 STOP #3):reject 是 strict-over-postel 与
  fail-fast 的复合 —— agent 不必扫 envelope 找 `clampedLimit`,error message 本身
  就是 onboarding。Schema 不必新加 typed `requestedLimit / effectiveLimit / limitClamped`
  字段,output shape 保持不变(`records[]` + `warnings?` + `nextCursor?` + `statsRun` +
  `tsMsRange?`),commands.jsonl audit row 也不需要额外的 clamp-tracking 字段。

**Round 1 amendment(codex STOP 2026-05-27 #3 + 开放问题 #3):**Q7 原文走 silent
clamp + `clampedLimit: 10` warning,但 lock 草未具化 `clampedLimit` 是 typed top-level
字段、warning string、还是 audit-only metadata。codex 反对论据:无 typed signal 的
clamp 会让 agent 在 pagination 时把"我请求 100 但只回 10"错认为"没更多了",分页错
位;若要走 clamp,output schema 必须显式加 typed 字段并锁 acceptance。两个 defensible
方向(clamp + typed schema 字段 / 硬 reject)对比下,**reject 形式更简单**
(output schema 不动,audit 不动,行为 deterministic)。最终落点:`fullRecords:true &&
limit > 10` → `query_malformed`,无 clamp 字段。Acceptance #3 同步改写(见 § Acceptance)。

#### Q8:`tsMsRange` 收紧 —— from + to 双 required + window cap

**Decision:`PoppoHttpQuerySchema.tsMsRange` 改为 `{from, to}` 双 required(strict)+
runtime 校验 `to - from <= MAX_WINDOW_MS_PER_SOURCE`(poppo_http 默认 24h)。**

```ts
// match.ts 增量:
tsMsRange: z.object({
  from: z.number().int(),                  // 现:.optional() → 现 required
  to:   z.number().int(),                  // 现:.optional() → 现 required
}).strict().optional()
   .refine(r => r === undefined || r.to >= r.from, "tsMsRange.to must be >= from")
   .refine(r => r === undefined || (r.to - r.from) <= 24 * 60 * 60 * 1000,
           "tsMsRange window must be <= 24h for poppo_http")
```

理由:

- 现 schema 两个字段都 `.optional()`,agent 打 `{from: 0}`(epoch 0)就过
  `narrowingFilter`(`tsMsRange !== undefined` → true),`bindSession` clamp 上
  `from = sessionStartMs` 之后等价于"从 session start 起返全部",defeats Block A。
  把 `from`/`to` 双 required + window-size cap 是釉根上 close 这个 bypass。
- 24h cap 是 evidence 数据的合理 working window —— session 最长不超过几小时;
  debug 复现往往是"几分钟内的 N 条相关 HTTP"。Cap 收紧到 24h 对真实场景无影响,
  对 adversarial `{from: 0, to: nowMs}` 是硬挡。
- 24h cap 现阶段 **hardcoded in `poppo_http/match.ts`**(Round 1 修订);不在
  `EvidenceSource` 接口加 `evidenceWindowCapMs?: number` typed surface。理由同
  Q5 / Q6 redact policy:MVP 一贯做法,触发条件 = 接入第二 source 且其窗口需求
  不同。**Round 1 amendment(开放问题 #6):** lock 草原文同时讲 "source-side
  declare default 24h" 与 "MVP hardcode",codex 抓为内部矛盾。最终落点:hardcode now,
  source-declared 字段留给 future v2-G.X candidate;开放问题 #6 nodded with hardcode。
- `extract_evidence_context` 内部组的 `tsMsRange = {from: marker-beforeMs, to: marker+afterMs}`
  本来就是双 bounded;window cap 60 s ≤ 24 h,no-op。

**Round 1 amendment(codex STOP 2026-05-27 #2):** Q8 原文锁了 agent-input
`tsMsRange` 双 required,但 codex 抓到一个 contract violation:现行
`poppo_http.bindSession`(`server/src/profile/poppo-vone/poppo_http/source.ts:222-228`)
在 agent **未传** `tsMsRange` 时会**合成** `{tsMsRange: {from: sessionStartMs}}`
(单边 from,无 to),给 effective parsedQuery 注入了一个违反新 schema 不变量的
形状。tightening Q8 之后,effective query 必须保持"either absent or `{from,to}`
both-bounded"。最终落点:`poppo_http.bindSession` 行为同步收紧 ——

```
// New bindSession semantics (Round 1 amendment):
//
//   if query.tsMsRange === undefined:
//       return query unchanged                  // no synthesis
//   else (tsMsRange present, schema 已保 {from,to} 双 bounded):
//       return { ...query, tsMsRange: { from: max(query.tsMsRange.from, ctx.sessionStartMs),
//                                       to:   query.tsMsRange.to } }
```

Effect on agent contracts:
- Agent 想用 session-as-lower-bound 又不 narrow 任何字段:不行。必须提供
  `tsMsRange:{from,to}` 显式 OR 提供其它 positive narrowing(`pathPrefix` etc.)。
- `extract_evidence_context` 的内部 `tsMsRange` 注入仍 trigger 上述 clamp,
  因为它 always 提供 `tsMsRange`。
- Acceptance scenario #9 新增,断言 "无 tsMsRange + 非时窗 positive filter
  (`pathPrefix`)" 路径上 bindSession 不合成 partial range。

#### Q9:`narrowingFilter` 不再接受 `{from: 0}` —— 还需 narrowingFilter 改吗?

**Decision:不需要。** Schema 收紧后,`{from: 0}` 直接在 zod parse 阶段被 caught
(`to` 缺失);`narrowingFilter` 检查 `tsMsRange !== undefined` 的逻辑不变 ——
它只看 dispatch 后的 parsedQuery,parsedQuery 不可能存在 `{from:0}` 而 `to` 缺失。

收紧路径变成:

```
agent input {tsMsRange:{from:0}}
    → zod parse fails (to required)
    → throws query_malformed (not query_underspecified)
```

`query_malformed` 错码与 `query_underspecified` 在 error code 上 distinct,agent
分支也清楚("字段形状错"vs"字段缺")—— 这是 v2-G Phase 3 已 lock 的两码区分,
本次扩展沿用。

### C. 审计与可观察性

#### Q10:commands.jsonl 多记什么?

**Decision:`search_evidence` / `extract_evidence_context` 的 aggregate row 加 4 字段:**

```
{
  tool, statsRun, pullsTriggered, pulledFiles, ts,
  // 新增:
  fullRecords: boolean,                  // input 的 fullRecords(default false)
  truncatedRecords: number,              // 本次 page 中 _meta.preview.truncated=true 的条数
  truncatedFullBytesSum: number,         // ∑ fullSizeBytes for truncated records
                                         // ("agent 若 fullRecords:true 一次性吃下的 token 数")
  savedBytesSum: number                  // ∑ (fullSizeBytes - JSON.stringify(previewed).byteLength)
                                         // ("本次 preview 实际省下的 token 数")
}
```

理由:

- audit row 是用户事后 diff 用的 —— 既然 preview 是"省 token"的 explicit value
  prop,得让用户能算出 sprint 期间到底省了多少。`truncatedFullBytesSum` 是
  "假如 fullRecords 会吃多少",`savedBytesSum` 是"实际省了多少",两值分开记 ——
  压缩比 = `savedBytesSum / truncatedFullBytesSum`,直观。
- soft-empty / `fullRecords:true` / 全条不达阈值 三种路径都 well-defined:
  - soft-empty:`truncatedRecords:0, truncatedFullBytesSum:0, savedBytesSum:0, fullRecords:false`
  - `fullRecords:true`:`truncatedRecords:0, truncatedFullBytesSum:0, savedBytesSum:0, fullRecords:true`
  - 全条不达阈值:`truncatedRecords:0, truncatedFullBytesSum:0, savedBytesSum:0, fullRecords:false`
- 不写 events.jsonl —— preview 不是"真实发生的物理事件",是 read-time transform。
  events 写真实 device IO(pull / capture / mark),preview 不属此类。
- 不为 Q7 reject path(`fullRecords:true && limit > 10`)记 audit row —— 那是
  `query_malformed`,与 query schema 错同体例,handler 在 throw 前 not 写。

**Round 1 amendment(codex advisory 2026-05-27):** Q10 原文用单字段 `truncatedBytesSum`
但语义模糊 —— 是"原本会吃多少" 还是 "实际省了多少"?codex 抓为命名误导:从
field 名看像 "sum of bytes that got truncated"(saved),但实际算法是
"sum of full bytes of records that were truncated"(would-have-eaten)。最终落点:
**字段拆两条**,`truncatedFullBytesSum`(原本会吃)+ `savedBytesSum`(实际省),
分别明示语义;commands.jsonl test fixture 同步更新。同一轮 amendment 补一条:
Q7 reject path 不进 audit row(避免 swag 进 query_malformed 路径)。

#### Q11:vanilla / soft-empty 行为 + hook-no-op 区分

**Decision:三种 fallback 路径形态严格区分。**

| 路径 | `_meta.preview` 是否出现 | 语义 |
|---|---|---|
| Source 未声明 `previewForAgent?` hook | **不出现** | raw passthrough,等价 `fullRecords:true` |
| Source 声明了 hook,本条不达阈值(truncated:false) | **出现**,`{truncated:false, fullSizeBytes:N, truncatedFields:[]}` | "服务端跑了一次 preview,认定不需截断" |
| `fullRecords:true` 显式开关 | **不出现** | agent 显式付代价 |
| Soft-empty(无 profile / source 不存在) | N/A(`records:[]`) | dispatch 前就 return,不进 runtime |

理由:**Round 1 amendment(codex advisory 2026-05-27):** Q11 原文只写"Source 未
声明 hook → 等价 fullRecords:true",但未明示"声明了 hook 但本条不达阈值"路径上
`_meta.preview` 是否出现。两条路径都不动 record body,但 metadata 形态必须可区分 ——
否则 agent 看 record 无 `_meta.preview` 时不能判断"是这个 source 不支持 preview"
还是"恰好这一条不大"。最终落点:hook 声明就走 hook(即便 truncated:false 也注入
metadata),hook 未声明就 raw passthrough。Acceptance #2 同步改写以断言此区分。

### D. 实施分期

#### Q12:Phase 划分(Round 1 修订)

**Decision:4-phase 串行,每 phase 内部单一 behavior boundary;每 phase 完结
dispatch codex audit。**

```
Phase 1 — types + runtime invariant plumbing (no supported-source behavior change):
  - server/src/profile/types.ts:
      + PreviewResult interface(record / truncated / fullSizeBytes / truncatedFields)
      + EvidenceSource.previewForAgent?(record): PreviewResult 可选方法
  - server/src/evidence/runtime.ts: 添加 post-page hook 注入点("如果 source 声明
    previewForAgent 则 page-slice 后逐条调用 + 注入 _meta.preview;_meta collision
    时 throw")—— 但因 poppo_http 还未声明 hook,运行时行为 unchanged
  - tools 边界 / match.ts schema 全不动 —— **行为 invariant**
  - Test:所有现有 808/808 继续过;新增 1 个 unit 测 "runtime 检测
    record._meta !== undefined 抛 RuntimeError"(fake source 注入冲突)
  - codex Phase 1 audit(behavior-frozen 验证 + interface shape 评审)

Phase 2 — poppo_http.previewForAgent impl + tsMsRange schema 双 required +
         bindSession 不合成:
  - 新文件:server/src/profile/poppo-vone/poppo_http/preview.ts
  - poppo_http/source.ts:
      + previewForAgent = previewPoppoHttpRecord
      + bindSession 重写:tsMsRange 缺席 → 不合成;tsMsRange 在 → 只 clamp from
  - poppo_http/match.ts:tsMsRange schema 改 from/to 双 required + 24h window cap refine
  - Test:
      + preview 各 hotspot path(body.text / body.decoded / both / neither)
      + bindSession 非合成回归(`pathPrefix:'/x'` 不带 tsMsRange → 不合成)
      + 旧 fixture 里"只传 from"案例同步加 to(grep 'tsMsRange:.*{from' 一遍)
  - 行为变化首次 user-visible:此 phase 完结后 v0.5.0 caller 真打 `{from:0}` 会 fail
  - codex Phase 2 audit

Phase 3 — tools 边界扩展 + reject 路径:
  - search_evidence / extract_evidence_context inputSchema 加 fullRecords + handler:
      + fullRecords:true && limit > 10 → throw query_malformed(reject path)
      + fullRecords:true:跳过 source.previewForAgent
      + 默认(fullRecords:false 或缺):走 source.previewForAgent(若声明)
  - Test:
      + fullRecords:true 路径 + 边界(limit==10 通过,limit==11 reject)
      + 默认 preview 路径在两 tool 上对称工作
      + extract_evidence_context 在 fullRecords:false / true 两路径都 verify
  - codex Phase 3 audit

Phase 4 — commands.jsonl audit row + 真机 acceptance:
  - search_evidence / extract_evidence_context handler 写 aggregate row 加 4 字段
    (fullRecords / truncatedRecords / truncatedFullBytesSum / savedBytesSum)
  - commands.jsonl test fixture 同步扩(audit row 形态)
  - 真机 acceptance(§ Acceptance scope 全部 10 scenarios,含 Round 1 新增
    #9 bindSession 非合成回归 + Round 2 扩展 #10 三路径 `_meta` collision)
  - codex Phase 4 final audit
  - cut v0.5.1 tag
```

预期 codex 4-5 轮 STOP(handoff projection)—— 与 v2-F.1 5 轮 STOP 经验对齐。

**Round 1 amendment(codex STOP 2026-05-27 #4):** Q12 原文 Phase 1 标 "interface +
types only (no impl)" 但 phase 内容含 tool inputSchema 改 / match.ts schema 改 /
runtime preview 调用接入 / limit clamp 逻辑,实际是 4 个 public behavior 改动;
Phase 3 又重复 tsMsRange 迁移。codex 抓为 phase boundary 内部自相矛盾。最终落点
(上表):**每 phase 单一 behavior boundary** —— Phase 1 真 types-only(运行时
hook 点注入但 source 未声明所以 unchanged behavior),Phase 2 起 user-visible
变化首次出现(`bindSession` 不合成 + tsMsRange schema 双 required + preview impl
合并到同 phase 因 bindSession 与 tsMsRange 是一对儿)。Phase 3 单管 tool 边界,
Phase 4 单管 audit + acceptance + cut。

## File layout

```
server/src/profile/
├── types.ts                                # PreviewResult interface +
│                                            previewForAgent?(record) optional method
└── poppo-vone/poppo_http/
    ├── preview.ts                          # 新文件 —— previewPoppoHttpRecord +
    │                                          THRESHOLD_BODY_TEXT_BYTES 等常量
    ├── match.ts                            # PoppoHttpQuerySchema.tsMsRange 改
    │                                          {from,to} 双 required + 24h window cap
    └── source.ts                           # previewForAgent: previewPoppoHttpRecord
                                              + bindSession 不合成 partial range
                                              (Round 1 amendment)

server/src/evidence/
└── runtime.ts                              # searchEvidence 在 page slice 之后:
                                              ① pre-projection invariant(Round 2
                                                 amendment):全 pageRecords 检查
                                                 `record._meta === undefined`,
                                                 有则 throw —— 不论 preview 路径
                                                 / fullRecords:true / no-hook
                                              ② projection transform:若 source
                                                 声明 previewForAgent 且 !fullRecords
                                                 → 调 hook,注入 _meta.preview
                                              ③ 否则:raw passthrough
                                              limit 与 reject 在 tool handler 层

server/src/mcp/tools/
├── search_evidence.ts                      # inputSchema 加 fullRecords +
│                                              fullRecords:true && limit > 10 reject +
│                                              commands.jsonl row 扩 4 字段
└── extract_evidence_context.ts             # 同上,内部 tsMsRange 注入不动

server/tests/
├── profile/poppo-vone/poppo_http/preview.test.ts        # 新 unit 测 preview 各路径
├── profile/poppo-vone/poppo_http/bind_session.test.ts   # 新 unit 测 bindSession
│                                                          不合成 partial range
├── evidence/runtime.test.ts                # _meta collision throw + page-slice-after invariants
├── mcp/search_evidence.test.ts             # 加 fullRecords / reject / preview path 用例
└── mcp/extract_evidence_context.test.ts    # 加 fullRecords / preview path 用例
```

## 开放问题(Round 1 全部 resolved)

下列 6 条本草各锁一个**默认立场**,Round 1 codex 全部 nod 或要求修订;状态如下。
完整 amendment provenance 见 § Amendments § "Round 1"。

1. ✅ **`_preview` flat vs `_meta.preview` 嵌套** —— Round 1 codex push 改 `_meta.preview`
   (反对论据:future `_meta.redaction` / `_meta.cached` 不需 shape migration;runtime
   collision 检测可强制 source.parseLine 不污染 `_meta`)。**Nodded with `_meta.preview`**;
   Q3 已 inline 修订。
2. ✅ **`fullSizeBytes` bytes vs token count** —— Round 1 codex nod with utf8 bytes
   (producer 已用 `textBytes` / `previewBytes` 同 vocabulary;token-aware 字段是 future
   `estimatedTokens`,不 overload `fullSizeBytes`)。**Nodded as drafted**。
3. ✅ **`fullRecords:true` clamp vs reject** —— Round 1 codex 倾向 reject for strictness;
   分析下 reject 更简单(output schema 不动,audit 不动,deterministic)。**Switched to
   reject** in Q7。`fullRecords:true && limit > 10` → `query_malformed`。
4. ✅ **preview 调用点:page-slice 之前 / 之后** —— Round 1 codex nod page-slice-after,
   并要求显式 lock 不变量:preview MUST NOT 影响 matchQuery / sortKey / cursor 编码 /
   recordsScanned / nextCursor(纯 read-time 投影,O(limit))。**Nodded with invariants**;
   见 § Q5b 新增 invariants 段(Round 2 修正了原指向 "§ Q4 末" 的 stale pointer)。
5. ✅ **`tsMsRange` 硬切 vs shim** —— Round 1 codex nod hard cut(零 caller);但抓到
   `poppo_http.bindSession` 会**合成** partial range,破坏新 invariant。**Nodded with
   bindSession amendment**(见 Q8 末)。
6. ✅ **24h window cap 是 hardcode 还是 source-declared** —— Round 1 codex push hardcode
   now(`evidenceWindowCapMs?` 加入 interface 是 future v2-G.X);本草内部矛盾
   ("source-side declare default 24h" + "MVP hardcode"两句话冲突)同步 cleanup。
   **Nodded with hardcode** in `poppo_http/match.ts`。

## Amendments(codex grill 与 audit 期间 fold-in)

### Round 1 — 2026-05-27 — codex pre-impl plan review STOP

Codex 在 round 1 给 5 条 blocking + 3 条 advisory + 6 条 open-question 答案。下列
索引按"blocking → advisory → open-question"分段,每条 link 回已 fold-in 的 inline
amendment 位置;原 Q-decision 文不动,以 callout 形式追加修订。

**Blocking issues(全 fold-in):**

1. **extract_evidence_context preview semantics 自相矛盾** ——
   原 acceptance #6 把 "不携 `_preview`" 与 "tsMsRange < cap" 绑定,但 preview 与
   time-window cap 无关。Fold-in:Acceptance #6 改写 —— extract 与 search 完全
   对称(默认 preview / `fullRecords:true` 走 raw),与 tsMsRange 解耦。详
   § Acceptance #6。
2. **`bindSession` 会撤销新 tsMsRange invariant** ——
   `poppo_http.bindSession` 在 query 无 `tsMsRange` 时合成 `{from: sessionStartMs}`
   单边 range,Q8 收紧后这是违规 effective query。Fold-in:bindSession 改"不合成,
   只在 tsMsRange 已在时 clamp from"。详 § Q8 末 amendment + Acceptance #9。
3. **`fullRecords:true` clamp 形状未在 schema 上锁** ——
   原 Q7 silent clamp + `clampedLimit` warning 未具化 typed 字段。Fold-in:
   switch to **reject**(`query_malformed`),output schema 不动。详 § Q7。
4. **Q12 Phase 边界自相矛盾** ——
   Phase 1 标 "types only" 实含 4 类 public behavior 改;Phase 3 重复 tsMsRange
   迁移。Fold-in:phase 重排为单一 behavior boundary,4 phase 清楚分工。详 § Q12。
5. **`_preview` namespace 未锁** ——
   flat `_preview` 容易被 source 误产出。Fold-in:switch to `_meta.preview` +
   runtime 检测 `record._meta` 冲突 throw。详 § Q3 + § Acceptance #10。

**Advisory(全 fold-in):**

- `truncatedBytesSum` 字段名误导(从名看像"已省字节",实际算法是"被截记录的
  原始字节和")。Fold-in:拆为 `truncatedFullBytesSum`(原本会吃)+
  `savedBytesSum`(实际省),audit 字段共 4 条。详 § Q10。
- Acceptance #2 未明示 "hook no-op" 与 "无 hook" 两路径上 `_meta.preview` 的区分。
  Fold-in:§ Q11 新增三栏表 + Acceptance #2 改写。
- `fullRecords:true && limit > 10` reject 路径不进 commands.jsonl audit
  (与 query_malformed 同体例)。详 § Q10 末。

**Open-question 答案(6 条全 fold-in,见 § 开放问题 当前列表)。**

### Round 3 — 2026-05-28 — codex verify STOP(stale-text residuals)

Codex round 3 verify 后给"narrow STOP"—— Round 2 三条已 closed,但 doc 别处仍有
3 条 stale text 与新 contract 不齐。无新架构问题。全部 fold-in。

**Blocking issues(全 fold-in):**

1. **Baked-in assumption #4 仍写 "per-source 可降"** ——
   顶层 § 文档定位 Block A 与 Q8 都已统一到 "poppo_http hardcode 24h in `match.ts`;
   future v2-G.X 才下放 source-declared",但 § Baked 假设 #4 残留 "per-source 可降"。
   Fold-in:#4 重写,删 "per-source 可降",改 "`poppo_http` 本 sprint hardcode 24h
   in `match.ts`,对 extract 的 60 s window 是 no-op;source-declared 是 future
   v2-G.X candidate"。详 § Baked-in #4。
2. **Q3 末 amendment 仍标 "Phase 2 实施"** ——
   Q5b + Q12 + Round 3 dispatch 全部说 `_meta` collision invariant 在 Phase 1
   落地(与 types.ts + runtime.ts hook 接口同 phase),但 Q3 末 Round 1 amendment
   callout 残留 "Phase 2 实施"。Fold-in:Q3 改 "实施位置 Phase 1 —— 与 types.ts
   加 hook 接口同 phase;Round 2 amendment 把检测从 preview 分支拔成全局
   invariant,详见 § Q5b"。详 § Q3 理由段 + 末 amendment callout。
3. **Q12 Phase 4 仍写 "8 scenario"** ——
   Acceptance scope 已扩到 10(Round 1 加 #9 + Round 2 扩 #10 三路径)。
   Fold-in:Phase 4 acceptance 行改 "全部 10 scenarios,含 Round 1 新增 #9
   bindSession 非合成回归 + Round 2 扩展 #10 三路径 `_meta` collision"。
   详 § Q12 Phase 4。

无 advisory。

### Round 2 — 2026-05-28 — codex verify STOP(narrow contract fixes)

Codex round 2 verify 后给"narrow STOP"—— Round 1 五条 blocking 方向上闭合,但有 3 条
contract-text 矛盾。无新架构问题。全部 fold-in。

**Blocking issues(全 fold-in):**

1. **`_meta` collision 检测 scope 与 Q3 全局 reservation 矛盾** ——
   Q3 锁 `_meta` 为 server-owned 全局命名空间(source 全局禁止产出),但 Q5b 原
   伪码把 collision 检测放在 `if source.previewForAgent && !input.fullRecords`
   分支内,等价于"`fullRecords:true` 或 no-hook source 路径上 source 产 `_meta`
   静默穿过"。Fold-in:**collision 检测拔到 pre-projection invariant 单独一步**,
   对所有 pageRecords 跑(invariant #6 in Q5b);Acceptance #10 扩三路径全覆盖
   (preview path + fullRecords:true bypass + no-hook bypass)。详 § Q5b
   Round 2 amendment + § Acceptance #10。
2. **顶层 § 文档定位 Block A summary 仍写 "per-source declared 默认 24h"** ——
   与 Q8 / 开放问题 #6 的 hardcode 决议矛盾;codex 在 round 1 已 nod hardcode-now。
   Fold-in:顶层 summary 改 "`poppo_http` 本 sprint hardcode 24h in `match.ts`;
   source-declared `evidenceWindowCapMs?` interface 是 future v2-G.X"。详 §
   文档定位 段 Block A 行。
3. **Q1 fallback wording 与 Q11 三栏表矛盾** ——
   Q1 说 source 不实现 → "raw + `truncated:false`",但 Q11 (Round 1 fold-in)说
   no-hook → 不注入 `_meta.preview`。Q1 残留 wording 会让 implementer 在 no-hook
   路径合成 metadata。Fold-in:Q1 改 "raw passthrough,不注入 `_meta.preview`",
   `truncated:false` 仅限 hook 声明且本条不达阈值。详 § Q1 末行。

**Advisory(全 fold-in):**

- § 开放问题 #4 答案里 "见 § Q4 末新增 invariants 段" 是 stale pointer ——
  invariants 落在 § Q5b。Fold-in:pointer 改 § Q5b。

## Acceptance scope(Round 1 修订)

Phase 4 末完结时跑下列 scenarios。Phase 1-3 中的 unit test 是 phase 内 GO 条件。

1. **preview happy path** —— Poppo `lang.json` 真实命中(~622 KB single record):
   - default fetch:`records[0]._meta.preview.truncated === true`,
     `records[0]._meta.preview.fullSizeBytes ≈ 622_000`,
     `records[0]._meta.preview.truncatedFields` 含
     `"response.body.text"`(及 `decoded` 若产 producer 写了),
     `JSON.stringify(records[0]).length < 5_000`
   - `fullRecords:true` fetch:`records[0]._meta === undefined`,
     `JSON.stringify(records[0]).length > 600_000`
2. **preview hook no-op vs no-hook 区分** ——
   - **Hook no-op**(声明了 hook 但本条 ~200 byte 心跳):
     `records[0]._meta.preview.truncated === false`,
     `records[0]._meta.preview.fullSizeBytes < 1_000`,
     `records[0]._meta.preview.truncatedFields.length === 0`,
     body 字段全保
   - **No hook**(用一个不声明 `previewForAgent?` 的 fake source verify):
     `records[0]._meta === undefined`(raw passthrough)
3. **`fullRecords:true && limit > 10` reject** —— `limit:11 + fullRecords:true`:
   - throw `query_malformed`,error message 明示
     "`fullRecords:true` requires `limit <= 10`; for more, paginate with `cursor`"
   - `limit:10 + fullRecords:true`:正常返,records 不含 `_meta`
4. **tsMsRange 双 bounded** —— `{tsMsRange:{from:0}}` 单 from 提交:
   - `query_malformed`,error message 明示 `to` 必填
5. **tsMsRange window cap** —— `{tsMsRange:{from:0, to:nowMs}}`(>24h):
   - `query_malformed`,error message 明示 cap is 24h
6. **extract_evidence_context preview 对称**(Round 1 改写):
   - default fetch(`fullRecords:false`):marker + 60s 双 bounded → records 携
     `_meta.preview`,语义与 search_evidence 一致(`truncated:true` if any record
     在 hotspot 命中)
   - `fullRecords:true` fetch:records 不含 `_meta`,内嵌 tsMsRange 仍 60s
7. **commands.jsonl 审计** —— preview happy path 跑完后:
   - 对应 row 含 `fullRecords:false`、`truncatedRecords > 0`、
     `truncatedFullBytesSum ≈ 622_000`、`savedBytesSum ≈ 617_000`(具体差值视
     preview body 头长度);压缩比 = savedBytesSum / truncatedFullBytesSum ≈ 99%
   - `fullRecords:true` row 含 `fullRecords:true` + 3 个 sum 字段全 0
8. **vanilla 项目** —— 无 profile,`fullRecords:true` 仍走 soft-empty 路径(因为
   dispatch 在 fullRecords gate 之前):`records:[]`,warnings 不变
9. **`bindSession` 非合成回归**(Round 1 新增):
   `search_evidence({source:'poppo_http', pathPrefix:'/x'})` —— **无 tsMsRange**,
   pathPrefix 是 positive narrowing:
   - 进 `searchEvidence`,effective query 经 `bindSession` 后仍**无** `tsMsRange`
     字段(不合成);match 仍正常 narrow by pathPrefix
   - 防回归:旧 v0.5.0 行为是合成 `{from: sessionStartMs}`,v0.5.1 起不合成
10. **`_meta` collision detection — 三路径全覆盖**(Round 1 新增 + Round 2 扩展):
    构造一个 fake source 让 `parseLine` 返回带 `_meta:{anything}` 的 record。
    检测必须在三种调用 shape 上都触发(pre-projection invariant,与 preview 启用
    与否解耦):
    - (a) **preview path**(`previewForAgent` 声明 + `fullRecords:false`):runtime
      在 page slice 之后、preview projection 之前 throw
    - (b) **fullRecords:true bypass-shape**(`previewForAgent` 声明 + `fullRecords:true`):
      runtime 仍 throw —— `fullRecords:true` 不绕开 `_meta` invariant
    - (c) **no-hook bypass-shape**(`previewForAgent` 未声明):runtime 仍 throw ——
      no-hook 也不绕开 `_meta` invariant
    
    错误形态(三路径相同):
    - throw `Error("source '<id>' produced record with reserved key _meta;
      _meta is a server-owned metadata namespace")`
    - tool handler 转化为 `internal_error`(与现有 source bug surface 同体例),
      audit 不写 row

详细 fixture / test 蓝图在 Phase 1 起开 [`./test-plan-v2g1.md`](./test-plan-v2g1.md)
(本 sprint 内开;Phase 1 plan-review 时 codex 一并 grill 测试 coverage)。

## Release 节奏

- Phase 1 完 → 不 cut(behavior-frozen,只新增 interface field + runtime hook 点)
- Phase 2 完 → 不 cut,但 user-visible 行为首次变化(`tsMsRange` 双 required +
  `bindSession` 不合成 + poppo_http preview impl)
- Phase 3 完 → 不 cut,tool 边界对称扩 fullRecords + reject path
- Phase 4 完 + 10 真机 scenario 全过 + codex round N GO → cut **`v0.5.1`** tag
- 同 tag 同时 close 两条 backlog 技术债:Block A 软 bypass + per-record preview
- `v0.5.1` 与 `v0.5.0` 之间的差异 100% 在 `search_evidence` /
  `extract_evidence_context` 默认响应形态变化(record 多了 `_meta.preview` 字段;
  `tsMsRange` 形状变严;`bindSession` 不合成 partial range);release note 必须
  显著提示此三点

## 依赖前置

- ✅ v0.5.0 cut(`4a7e0e2`) —— annotate 已收敛,本 sprint 独立于 v2-F.1
- ✅ v0.4.0 Block A `validateNarrowingFilter` 已 lock —— 本 sprint Q9 假设它在场
- ✅ Poppo HTTP source 真机数据可达(同 v2-G Phase 5 acceptance fixture)
