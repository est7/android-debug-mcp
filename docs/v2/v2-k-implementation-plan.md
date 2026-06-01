# v2-K 实施计划 — Evidence Retrieval Order(current-page ergonomics / F3)

状态:**locked**(sign-off 2026-06-01)。执行者:Codex。self-contained 执行规格,设计已锁定,实现时**不要重新推导设计**,按本文做。

## 0. 背景与目标(为什么)

`poppo_nav` 等 streaming 证据源按**文件追加序 = tsMs 升序**返回,且 `limit` 截断取**最旧的 N 条**(`evidence/runtime.ts` 的 `runStreamPath`)。后果:

- `search_evidence({source:"poppo_nav"})` 默认回**最旧**记录;要拿「当前可见页」(= 最新一条 nav)得一路翻 `nextCursor` 到最后一页 `.at(-1)`。
- 这恰恰是 v2-H 的北极星「当前页 → 接口归因」最高频的入口 —— 反而最别扭。
- 真机 e2e `v2h_acceptance` 已被此绊到:单页 `.at(-1)` 取到的是启动期旧记录,被迫改成翻 cursor 收全(`navNow`,commit `0e5a403`)。

v2-K 给 `search_evidence` 加一个**通用取最新方向** `order`,让「当前页 / 最近 N 条」一次调用拿到。**纯检索机制,不含任何业务语义**(符合 [[mcp-business-semantics-as-data-not-code]] 判据:`order` 是机制不是 Poppo 词汇,放 core 合规)。

## 1. 执行约定(每个 phase 都遵守)

- **Runner 是 `vitest run`**(用 `bun run test`),不是 `bun test`。
- **TDD**:每 phase 先写失败测试(RED),再实现(GREEN),最后全 gate。
- **Gate**:`bun run typecheck && bun run lint && bun run test` 三绿才算 phase 完成。
- **Per-phase codex audit gate**:实现 + gate 绿后出改动摘要待 codex 审,通过再进下一 phase。
- **契约即公共接口**:tool description / inputSchema / 输出顺序都是 public contract;改动写进 description。
- **MCP input 校验**失败经 SDK 表现为 `{isError:true}`(memory `mcp-sdk-input-validation-surfaces-as-iserror`)。
- 语言:代码/标识符/测试 English;本文 rationale 中文。

## 2. 锁定的设计决策(勿翻案)

- **入参位置**:`order?: "asc" | "desc"` 加在 `search_evidence` 的**工具顶层入参**(与 `limit`/`cursor`/`fields` 同级),**不进** source-specific `query` —— 检索方向是通用关注点,非源语义。默认 `"asc"`(现有行为,完全向后兼容)。
- **`extract_evidence_context` 不动** —— 它是 marker 窗口 + 多源 tsMs 升序合并,顺序是其语义的一部分;v2-K 只作用于 `search_evidence` 单源路径。
- **`desc` = 单页、不分页**(YAGNI,绕开 keyset-desc cursor 复杂度,复用多源时间线那套「单页截断」简化):
  - `desc` 返回**最新的 `limit` 条**,按 tsMs **降序**(`records[0]` = 最新),`nextCursor` **永不设置**。
  - `order:"desc"` 同时带 `cursor` → `query_malformed`(消息:`desc order does not paginate; omit cursor`)。
  - `asc`(默认)路径分页 / cursor 行为**完全不变**。
- **两种迭代模式的 desc 实现**:
  - **有 `sortKey` 的源(`poppo_http`)**:`runSortPath` 已 collect-all-in-window;desc 时把排序换成**按 `sortKey` 降序**,`slice(0, limit)`,不出 cursor。
  - **streaming 源(`poppo_nav` 及无 sortKey 源)**:`runStreamPath` 扫全集时维护一个**容量 `limit` 的 ring buffer**(保留最后 `limit` 条命中,O(limit) 内存、O(n) 扫描,不全收),扫完把 buffer(迭代序)**reverse** → 最新在前。
    - **正确性边界**:迭代序 = basename 升序 → 行序。对 `poppo_nav`(单文件 append-only)迭代序**精确等于 tsMs 序**,desc 精确;假想的多文件 streaming 源继承 `runStreamPath` 既有的「basename 近似时序」caveat(本就存在,非本次引入)。文档标注。
- **`bindSession` / `validateNarrowingFilter` 不受影响**:`order` 不参与收窄判定;`poppo_http` 仍需 `tsMsRange`(否则原 soft-warning),`poppo_nav` 无收窄要求。
- **`fields` / `fullRecords` 与 `order` 正交**:preview 仍逐条跑。
- **当前页正典 recipe**(写进 description + 文档):
  当前可见 fragment = `search_evidence({ query:{source:"poppo_nav"}, order:"desc", limit:1 }).records[0]`。

---

## Phase K1 — runtime + 工具入参(MCP 仓,hermetic)

PUBLIC_IMPACT:`search_evidence` 加 `order` 入参 + `desc` 输出顺序契约。

### K1.1 runtime
- `server/src/evidence/runtime.ts`:
  - `SearchEvidenceInput` 加 `order: "asc" | "desc"`(必填,工具层默认 `"asc"`)。
  - `searchEvidence(...)` 分派:`order==="desc"` 时走 desc 分支。
  - `runSortPath`:desc → 按 `sortKey` 降序比较,`slice(0, limit)`,`nextCursor` 不设。
  - `runStreamPath`:desc → ring-buffer 最后 `limit` 命中,reverse 返回,`nextCursor` 不设。
  - `desc` 且传入 `cursor` → 抛 `ToolDomainError("query_malformed", "desc order does not paginate; omit cursor")`(在工具层或 runtime 入口校验,先于迭代)。
- `statsRun`(filesScanned/recordsScanned/…)语义不变;desc 仍全扫(ring-buffer 不改扫描量)。

### K1.2 工具
- `server/src/mcp/tools/search_evidence.ts`:
  - inputSchema 加 `order: z.enum(["asc","desc"]).optional()`(默认在 handler 里补 `"asc"`)。
  - 透传到 `searchEvidence`。
  - description:`Args` 增 `order`(默认 `asc` 升序分页;`desc` = 最新优先、单页、不分页、不与 `cursor` 同用);`Returns` 写明 `desc` 时 `records` 降序、无 `nextCursor`;附「当前页」recipe。

### K1.3 测试(RED→GREEN)`server/tests/mcp/search_evidence.test.ts` + `server/tests/evidence/*`
- streaming 源:写 N(>limit)条升序 fixture → `order:"desc", limit:3` → 返回**最新 3 条、降序**、无 `nextCursor`;`order:"asc"`(或缺省)仍最旧 3 条 + `nextCursor`。
- sortKey 源(fake_src / poppo_http fixture):`order:"desc"` → 按 sortKey 降序 top-limit、无 cursor。
- `order:"desc"` + `cursor` → `query_malformed`。
- 「当前页」: nav fixture 多条 → `order:"desc", limit:1` → `records[0]` = tsMs 最大那条。
- `order` 与 `fields`/`fullRecords` 共用:desc 下 preview 仍生效。
- 既有 asc 分页 / cursor 测试全绿(回归)。

### K1.4 Gate + audit

---

## Phase K2 — 文档 + e2e 简化 + 真机校验

### K2.1 文档
- `docs/v2/preview-for-agent.md`(或相应检索文档):补 `order` 语义 + 「当前页」recipe + streaming-desc 的 basename 近似 caveat。
- `docs/README.md`:登记本 plan。

### K2.2 简化 v2h_acceptance(顺带回归证明新路径)
- `server/tests/e2e/v2h_acceptance.test.ts` 的 `navNow`:从「翻 cursor 收全」改为单次 `order:"desc", limit:N`(N 取足够大,如 50),`.at(0)` = 最新。保留语义不变(当前页断言仍成立)。**改完真机重跑 v2h e2e 验证。**

### K2.3 真机校验
- opt-in e2e 加/改一条:`search_evidence({source:"poppo_nav"}, order:"desc", limit:1)` 的 `records[0].name` = 当前可见 fragment(与 `get_app_state` 的前台一致性弱断言,或与连续 tab 切换后的最新一致)。

---

## 依赖与顺序
K1(runtime + 工具,hermetic TDD)→ K2(文档 + e2e 简化 + 真机)。K1 不依赖真机;K2.2/K2.3 需设备。

## 不在范围(v2-K 明确不做)
- `desc` 的**反向深分页**(backward cursor)—— 单页够用,YAGNI;真有需求再开。
- `extract_evidence_context` 的 `order`(时间线本就升序合并)。
- 专用「current page」工具 / 任何 Poppo 语义化(违解耦)。
- `tail:N` 备选形态(`order:"desc"` + `limit` 已覆盖「最近 N」)。
