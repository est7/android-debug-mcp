# Android Debug MCP — v2-G Implementation Plan · Profile + EvidenceSource

Locked design: [`profile-and-evidence.md`](./profile-and-evidence.md)。

本计划带 v2-G 从 v2-F.0(21 tool / `0.3.0`)到 23 tool + 1 reference profile + 1
reference source + Q6 redact wiring 全部跑通。

**栈**:沿用 v1 / v2-A / v2-F —— TypeScript + Bun ≥ 1.1、`@modelcontextprotocol/sdk` 1.x、
`zod` 3.x、`vitest` 1.x、`@biomejs/biome` 1.9.x。v2-G **不引入新 runtime
dependency**;不引入新 spawn binary;不动 logcat / capture / source-mapping。

**修订记录**:
- 2026-05-25 design seed grill,Q1-Q12 nod-locked
- 2026-05-25 ~ 2026-05-26 5-phase 实施 + 4 round 通信(每 phase pre-impl plan
  review + post-impl audit)
- 2026-05-26 design lock + 实施计划落盘(本文件)

## 关键设计约束(实施时不得偏离)

- **不引入 SourceProfile 抽象**(reject v2-H scope creep)。v2-A `source/recipe.ts`
  Poppo-bake **暂留**,触发条件 = 接入下个月任意非 Poppo Android 项目;v2-G MVP
  跳过它就是为了延迟决策、等真实第二 app 数据进来再 abstract。
- **不引入 selector / source-discovery**;profile 是 code-level surface change
  (`server/src/profile/<name>/`),不动态扫描。
- **Tool inventory 21 → 23**(`search_evidence` + `extract_evidence_context`)。
  v1 17 tool / v2-A 2 tool / v2-F 2 tool 全部不动。
- **Q6 redact 是 collect_bundle 的硬出口**,不在 search / extract 路径;agent
  视角 raw,bundle 出口走 source.redactForBundle。
- **新硬错码**(Phase 1 已有 `profile_malformed`/`profile_unknown`;Phase 3 加
  `query_malformed`;Phase 5 加 `evidence_redaction_unavailable`)进 typed catalog;
  zod schema 校验失败不进 typed catalog(同 v1 现有 zod 拒绝路径)。
- **events.jsonl / commands.jsonl 持久化格式 additive 扩**:`evidence_pulled`(只
  on real pull)+ `evidence_seal_failed`(stop_session seal 路径)+ aggregate
  command rows。Q9 capture-mirror 体例,不破坏 v2-F 既有 reader。

## Phase 1 — Profile loader + provenance(commit [`d5f8d3c`](https://example.invalid/d5f8d3c))

**Scope:**

- `server/src/profile/types.ts` —— `ProfileJsonSchema` + `Profile` 类型骨架
- `server/src/profile/loader.ts` —— `loadProfile(projectRoot)`:read / parse /
  validate / resolve via `findBuiltinProfile`。错路径:`profile_malformed`(I/O / JSON
  parse / zod fail)+ `profile_unknown`(name 不在 built-in registry)
- `server/src/profile/registry.ts` —— `findBuiltinProfile` + `builtinProfileNames`
- `server/src/profile/poppo-vone/index.ts` —— `POPPO_VONE_PROFILE` skeleton(零
  evidence sources;Phase 4 才填)
- `start_session` 调 `loadProfile`,写 `metadata.profile = loadedProfile.json` 或 null

**Codex cadence A:**pre-impl plan review + post-impl audit。

**Contract locked:**`profile.json` shape;hard-error 路径;profile-name → Profile
解析在 built-in registry 表中。

## Phase 2 — EvidenceSource interface + run-folder contract(commit [`fae127d`](https://example.invalid/fae127d))

**Scope:**

- `server/src/profile/types.ts` 扩 —— `EvidenceContext` + `DeviceFileEntry` +
  `EvidenceSource` 接口(`listDeviceFiles` / `pullFile` / `parseLine` / `matchQuery` /
  `redactForBundle`)+ `ParsedRecord` / `EvidenceQuery` open shape
- `server/src/adb/evidence.ts` —— `statMtimeMs` + `pullFile` thin wrappers
- `server/src/evidence/mtimeCache.ts` —— per-source mtime cache I/O(tmp+rename
  atomic;malformed → 硬错)
- `server/src/evidence/paths.ts` —— `sourceEvidenceDir` + `mtimeCachePath` + 子目
  常量

**Codex cadence A:**pre-impl plan review + post-impl audit。

**Contract locked:**`EvidenceSource` 接口契约(每个方法的输入/输出/异常 / 文件路径
约定);mtime cache 格式;无 concrete impl(留 Phase 4)。

Gates baseline: **567 → 599**(+32 new = interface contract tests + mtime cache
tests + adb thin wrapper tests)。

## Phase 3 — search_evidence + extract_evidence_context(commit [`00f1796`](https://example.invalid/00f1796))

**Scope:**

- 2 new tool handlers + lazy-pull runtime + Q4 dispatcher + Q9 audit shape +
  Q11 soft-empty。Inventory 21 → 23。
- 新增 contract surface(由 codex pre-impl plan + post-impl audit 共同雕刻):
  - `EvidenceSource.querySchema: z.ZodTypeAny` —— per-source strict zod;Q4 移到
    handler 内(SDK 边界 lax,handler 内严格)
  - Cursor module `cursor.ts` 5-layer defenses(stream 变体)
  - `sealEvidenceSource` separate pull-only path,被 `stop_session` 在 manager.stop
    之前调
  - `query_malformed` 错码 + `invalid_cursor`(后者 Phase 1 已存在,Phase 3 复用)

**Codex cadence A:**pre-impl plan review(4 amendments folded)+ post-impl audit
(1 required fix M1 = mkdir cleanup window + 3 polish items D/F/G,全部 folded)。

**Contract locked:**`search_evidence` / `extract_evidence_context` 公共 schema;
Q11 soft-empty 形态;Q9 audit row 形态;cursor codec(stream 变体)。

Gates: **599 → 650**(+51 new = handler tests + queryDispatch + cursor defenses
+ runtime + summary describeEvent)。

## Phase 4 — poppo_http source + sort/keyset cursor(commit [`b20fd78`](https://example.invalid/b20fd78))

**Scope:**

- First concrete `EvidenceSource`:`poppoHttpSource` 装入 `POPPO_VONE_PROFILE`
- 子文件 split(codex Phase 3 hint follow-up):`source.ts` I/O + `record.ts` schema +
  `match.ts` filter + `redact.ts` Q6 policy
- Schema rev4 全部接入,3 条 body invariants 用 `.superRefine` 强制
- Phase 3 contract widening(都是 optional 接口扩展):
  - `EvidenceContext.packageName: string`
  - `EvidenceSource.bindSession?(query, ctx): EvidenceQuery`
  - `EvidenceSource.sortKey?(record): readonly (string|number)[]`
  - Cursor `kind` discriminator(stream + sort 变体)
  - Runtime `runStreamPath` / `runSortPath` 双路径

**Codex cadence A:**pre-impl plan review(4 [need-nod] 决策 + 1 architectural
follow-up `R2` 选择 α-light)+ post-impl audit(V1 body invariants superRefine +
V2 stale-ls-entry test + sortKey doc tweak)。

**Contract locked:**`poppo_http.querySchema` 是 agent-visible filter contract(7
filter fields:pathPrefix / methodIn / outcome / excludeHeartbeat / tsMsRange /
hostContains / durationMsGte / errorTypeIn);outcome cascade
`transport → http(non-2xx) → app(2xx + ok=false) → ok`;sortKey `[tsMs, runId, seq]`;
cursor `kind:"sort"` 变体 keyset paginate。

Gates: **650 → 722**(+72 new = record schema + match + redact + source pure
paths + 4 integration cases via search_evidence handler)。

## Phase 5 (i) — collect_bundle Q6 wiring(commit [`42d048b`](https://example.invalid/42d048b))

**Scope:**

- `redactEvidenceDir(staged, profile)` 在 `createBundle` 内、`applyLogsPolicy` 前跑
  (so `logs:"raw"` 不能 disable evidence redact)
- 每个 `evidence/<source.id>/*.jsonl` line:parse via source.parseLine → 丢 null
  → source.redactForBundle → 写回(atomic tmp+rename within source dir)
- `.mtime-cache.json` 整个删(host-absolute localPath leak)
- collect_bundle handler 加 `resolveProfileForRedaction` —— 3 个 hard-error
  路径(null + evidence / 未知 profile name / 已知 profile 但未声明的 source dir)
  全部 surfaced 为 `evidence_redaction_unavailable` with branchable extras

**Codex cadence A:**pre-impl plan review(5 [need-nod] + α-δ answers)+ post-impl
audit(3 required impl fixes + non-blocking Dirent-filter tweak)。

**Contract locked:**evidence 在 bundle 出口 mandatory redact,**no opt-out**;
`acknowledgeUnredacted` 仅 logcat-scope;`evidence_redaction_unavailable` 错码 +
branchable extras。

Gates: **722 → 730**(+8 new = bundle test 4 evidence redact + handler test 4
error matrix)。

## Phase 5 (ii) — Real-device acceptance + 0.4.0 tag(pending,user-driven)

8 scenario manual checklist:[`./test-plan-v2g.md`](./test-plan-v2g.md)。无新代码;
acceptance pass 后 cut **0.4.0 tag** 覆盖 `v2-F.0 + v2-G + Poppo HTTP adapter`
(backlog § "release 节奏")。

## Codex audit cadence(Q12 cadence A summary)

| Phase | Pre-impl review | Post-impl audit | Result |
|---|---|---|---|
| 3 | GO + 6 amendments(Q4 union 落点 / cursor mtime / seal extraction / test seam / closed-run scope / emitter 位置 / seal_failed shape / inventory 漏点) | GO-with-fixes(M1 mkdir cleanup + D/F/G polish)→ all applied | locked |
| 4 plan | GO-with-fixes(R1 session scoping / R2 ordering vs cursor / R3 URL parse / R4 cascade)+ α-light choice on R2 | GO-with-fixes(V1 body invariants / V2 stale-ls test / sortKey doc)→ all applied | locked |
| 5 (i) plan | GO-with-fixes(α 至 δ + 3 required impl fixes)| GO + 1 non-blocking Dirent tweak → applied | locked |

每次 audit response 全部 archived in this thread(orchestrator session `collab`)。

## Gates progression

| Phase commit | tests | typecheck | lint |
|---|---|---|---|
| baseline pre-v2-G | 567 | clean | clean |
| Phase 2 (`fae127d`) | 599 (+32) | clean | clean |
| Phase 3 (`00f1796`) | 650 (+51) | clean | clean |
| Phase 4 (`b20fd78`) | 722 (+72) | clean | clean |
| Phase 5 (i) (`42d048b`) | **730** (+8) | clean | clean |

All commits pass `bun run typecheck && bun run lint && bun run test`。Phase 5 (ii)
acceptance attaches to this baseline。

## Release

hold 0.4.0 tag 至 Phase 5 (ii) acceptance done。Final cut 覆盖:

- v2-F.0(`list_elements` + `long_press` + 3 lock-level amendments)
- v2-G(2 evidence tools + `poppo-vone` profile + `poppo_http` source + Q6 wiring)
- Poppo HTTP adapter(submodulepoppo 侧 `CustomHttpLoggingInterceptor` 已 land)

Tag message 模板:

```
v0.4.0 — v2-F.0 element-driven interaction + v2-G profile/evidence

23 tools (21 → 23 via search_evidence + extract_evidence_context).
1st reference profile (poppo-vone) + 1st reference source (poppo_http).
collect_bundle Q6 evidence redact.

See:
  docs/v2/element-interaction.md           (v2-F.0 design lock)
  docs/v2/profile-and-evidence.md          (v2-G design lock)
  docs/v2/v2-g-implementation-plan.md      (5-phase breakdown)
  docs/v2/test-plan-v2g.md                 (real-device acceptance)
```

## Out of scope(deferred)

- **v2-H — SourceProfile extraction**:抽 v2-A `source/recipe.ts` Poppo-bake。
  触发条件 = 接入第二 Android 项目。
- **v2-G.1 — profile-owned redact policy**:Q6 list 下放 profile / source。触发
  条件 = 第二 source 且其敏感字段 ≠ Poppo 的。
- **Typed `ParsedRecord` at search_evidence output**:multi-source future 之前不
  做。
- **`SessionManager.start` mkdir cleanup regression test**:test-only DI hook
  / namespace-spyable helper 之前不做。Codex 两次 audit 接受 deferred。
