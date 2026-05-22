# Android Debug MCP — v2-A Implementation Plan · Tap-to-Source

Locked design: [`source-mapping.md`](./source-mapping.md)。本计划带 v2-A 从 v1
(17 tool / `0.2.0`)到 [`source-mapping.md`](./source-mapping.md) § 验收 scenario
5 条全跑通。

**栈**:沿用 v1 —— TypeScript + Bun ≥ 1.1、`@modelcontextprotocol/sdk` 1.x、
`zod` 3.x、`vitest` 1.x、`@biomejs/biome` 1.9.x。v2-A **不引入新 runtime
dependency**:`rg` 是外部 CLI,按 v1 `adb` 的 chokepoint 模式 resolve,不是 npm dep。

**修订记录**:2026-05-21 codex 计划评审 5 条 finding 已折入 —— projectRoot 持久化、
bootstrap 注册面、error catalog、Phase 0 hit-test tie-break、candidate `kind` 模型。

## 关键设计约束(实施时不得偏离)

- 映射方向单向 **runtime → source**。`tap_node` 必做 live `uiautomator dump`,
  无 source-only 捷径(design lock baked-in #2)。
- v1 的 17 tool、`events.jsonl` / `commands.jsonl` 持久化格式**不动**。v2-A 只
  新增 `tap_node` / `source_mapping` 两种事件 `type` 和两个 tool。
  `metadata.json` 仅做**加性**扩展(新增 `projectRoot` 字段,见 Phase 2)。
- v1 的 `tap` 工具保持纯净不动(Q3)。
- `events.jsonl` 事件去规范化、自足、隐私轻量 —— **不持久化运行时 `text` /
  `content-desc`**(Q4/Q6/Q8)。
- 无 `text` / `content-desc` fallback;framework / 包名不匹配的 `resource-id`
  不作锚点(Q4)。
- **源码根只认显式 `projectRoot`**:不从 `runRoot` 反推、不猜 cwd。`projectRoot`
  在 `start_session` 时解析并持久化;缺失 → 硬错 `project_root_missing`(Q5)。
- 新硬错码进 typed catalog(`toolError.ts`),每个 tool 的 `Errors:` 描述列全
  (v1 phase-10 纪律)。

## Phase 编号

v1 是 Phase 0–13。v2-A 重新从 Phase 0 起编号;源文件落 `server/src/ui/` 与新增
`server/src/source/`,与 v1 模块互不冲突。

---

## Phase 0 — uiautomator 层级 parser + hit-testing ⚠️ 关键路径

**目标**:纯模块。uiautomator dump XML → node 树;给定 (x,y) 解析出
`tappedNode` / `anchorNode` / `anchorSource` / `ancestorChain`。零 tool、零设备。

**Files**
- `server/src/ui/hierarchy.ts` — `parseUiHierarchy(xml)` → 嵌套 `UiNode` 树。
  每节点抽 `resourceId` / `class` / `package` / `bounds` / `index` /
  `clickable` / `focusable`;`bounds` 解析 `"[x1,y1][x2,y2]"` →
  `{left,top,right,bottom}` 整数。v1 `ui/summary.ts` 的正则计数保留不动
  (`capture` tool 仍用)。
- `server/src/ui/hit_test.ts` — `resolveTap(tree, x, y, sessionPackage)` →
  `{ tappedNode, anchorNode, anchorSource, ancestorChain }`。
- `server/tests/ui/hierarchy.test.ts` / `hit_test.test.ts` +
  `server/tests/fixtures/ui/*.xml`。

**hit-test tie-break 规则(实施 + 真机 fixture + codex audit 后定形)**

原 plan 写的"深度优先 / 最深 leaf"规则被真机 dump 否掉(全屏 `face_container` 里
更深的 `ivAvatarFace` 会盖过 top-bar 的 backButton);"无脑进最后包含子节点"又会扎
进透明 overlay 死掉。最终规则(见 `hit_test.ts`):

1. **候选过滤**:`bounds` 非 null、`right>left`、`bottom>top`(退化矩形天然不含
   任何点)。**负坐标合法** —— 部分滚出屏的 view 边界可为负,半开包含判定
   `[l,r)×[t,b)` 天然正确处理,不额外排除。
2. **多窗口**:`<hierarchy>` 可有多个 root。取**文档序最后一个**(z-order 最上层)
   且包含 `(x,y)` 的 root,只在它子树里找。
3. **逐层下降,topmost-first**:每层按文档序倒序(后绘制在上)遍历包含 `(x,y)` 的
   子节点;commit 到第一个「自身还有包含子节点(递归下降)或本身是叶子(即答案)」
   的子节点。
4. **空心非叶 = 透明容器 / scrim**:一个包含该点、但子节点都不包含的非叶节点 ——
   `clickable=true` 则是交互式 scrim / 点击拦截层(modal 遮罩、bottom-sheet
   scrim),Android 把 tap 派发给它,**直接胜出**;非 clickable 则是透明容器,仅在
   无更深兄弟可选时作 fallback,让透明 overlay 穿透到下层真实内容。
5. `anchorNode` 在 `tappedNode` 定下后,沿 `[tappedNode, ...祖先]` 取最近一个
   resource-id 属于 session 包名的节点;framework id(`android:id/*`)不作锚点(Q4)。

**Fixtures(至少覆盖)**:普通屏、dialog 浮层多 root、父子等 bounds、兄弟 bounds
重叠、RecyclerView 行复用、无有效 app id 节点。

**Verify**:Vitest only。

**风险**:v2-A 单一最高风险(对标 v1 Phase 4 parser)。真机 dump 有 `<merge>`、
`ViewStub`、自定义 View、多窗口、Unicode、非法 bounds。每份没见过的 fixture 都会
暴一个 bug。

---

## Phase 1 — `android_debug_tap_node` tool

**目标**:原子 capture-then-tap。复用 v1 `captureUiDump` + `inputTap`。

**Files**
- `server/src/mcp/tools/tap_node.ts` — input `{runId,x,y,label?}`;pre-tap
  `uiautomator dump` → Phase 0 `resolveTap` → `input tap` → 写 `tap_node` 事件
  + `capture` 事件 + `commands.jsonl`;output 镜像事件身份。失败语义 Q9:
  pre-tap dump 失败 → 硬错 `ui_dump_failed` 且 **tap 前中止**。
- `server/src/mcp/toolError.ts` — typed catalog 加 `ui_dump_failed`。
- `server/src/mcp/bootstrap.ts` — `registerAllTools` 注册 `tap_node`;
  `TOOL_COUNT` 17 → 18。
- `server/src/mcp/constants.ts` — `ANDROID_DEBUG_TOOL_NAMES` 加
  `android_debug_tap_node`。
- `server/src/summary/render.ts` — `get_run_summary` 渲染 `tap_node` 事件
  (时间线可读)。
- `server/tests/mcp/tap_node.test.ts` — fake adb:正常路径、pre-tap dump 失败
  → 硬错且未 tap、无锚点 → 软结果 `anchorNode:null`。
- `server/tests/integration/tool_contract.test.ts` /
  `server/tests/mcp/register.test.ts` — tool 数 17 → 18、`ANDROID_DEBUG_TOOL_NAMES`
  长度/唯一性、`tap_node` 的 `Errors:` 描述列全 `ui_dump_failed`。

**Delivers**:验收 scenario A 的 tap_node 半段、B(无锚点)、D 的 dump-失败段。

**Verify(真机)**:`tap_node` 点 Poppo 一个按钮 → 检查 `events.jsonl` 的
`tap_node` 事件 + `artifacts/ui-*.xml`。

依赖 Phase 0。**audit checkpoint**(节奏 A):本 phase 完成后过 codex。

---

## Phase 2 — projectRoot 持久化 + rg recipe + candidate 模型

**目标**:链 M 的源码侧基座。纯模块为主;含一处 v1 加性扩展。

**2.0 — projectRoot 持久化(v1 加性扩展,链 M 前置)**
- `server/src/store/paths.ts` — `resolveProjectRoot()`:`git rev-parse
  --show-toplevel`(host 启动目录);非 git → `null`。
- `server/src/store/metadata.ts` — `Metadata` 加 `projectRoot: string | null`
  字段(加性,旧 run 读出为 `undefined` 视同 `null`)。
- `server/src/mcp/tools/start_session.ts` + 写入路径 — start 时解析并持久化
  `projectRoot`。
- 回归测试:active run 带显式 projectRoot、finalized run 从磁盘读、
  env/fallback runRoot 且 projectRoot 缺失三种。

**2.1 — rg recipe**
- `server/src/source/rg.ts` — `rg` PATH resolve(对标 v1 `getAdbPath`:
  `RG_PATH` env → `which rg`,缺失抛 `RgNotFoundError`);`runRg(args,
  {timeoutMs})`,超时 → `search_timed_out`。
- `server/src/source/recipe.ts` — `resolveCandidates(resourceId, projectRoot)`。
  `submodulepoppo` 扫描确认 Poppo 是 **ViewBinding-only**(无 `findViewById`、无
  kotlin synthetics、DataBinding 声明了但未用),recipe 据此:
  - `android:id="@+id/<name>"` → 布局 XML 的 id 声明(`kind: id_declaration`)。
  - `binding.<camelCase(name)>` → Kotlin/Java 代码引用(`kind: code_ref`);
    snake_case id 先转 lowerCamel(`face_mask_top` → `faceMaskTop`),已是 camel
    的原样。**不搜 `R.id.xxx` / `findViewById`** —— Poppo 不用。
  - 布局文件名 → binding 类名(`activity_homepage_3.xml` →
    `ActivityHomepage3Binding`)→ `rg` 找 `BaseBindingActivity<XxxBinding>` /
    `BaseBindingFragment<XxxBinding>` 的那个类(`kind: screen_owner`)。**不是
    `R.layout.xxx`** —— Poppo 用泛型类型参数 + 反射 inflate,代码里无 `R.layout`。
  - 排除 `build/` 等生成目录(生成的 `*Binding` 类会淹没真实引用)。
  **输出 `SourceCandidate` 含 `kind` 分类**(见 2.2)。
- `server/src/source/project_root.ts` — 读 run 的 `metadata.projectRoot`;
  为 `null` → 调用方据此返回硬错 `project_root_missing`。

**2.2 — candidate `kind` 模型(从 design lock open decision 提为本 phase 交付)**
- `SourceCandidate = { file, line, kind, ... }`,`kind ∈ { id_declaration,
  screen_owner, code_ref, generated_noise }`(具体集合实施时按 Poppo 真实形态
  收口)。Phase 3 `confidence.ts` 依赖此稳定形状 —— 必须在 Phase 3 前定稿。

**Files 测试**:`server/tests/source/*.test.ts` +
`server/tests/fixtures/source/`(小型 fixture 源码树:layout XML + Activity +
ViewBinding 用例)。

**Verify**:Vitest only。2.1 / 2.2 可与 Phase 0/1 并行;2.0 触及 v1 start_session,
独立先行亦可。

**风险**:Poppo 的 view binding 机制待定 —— 实施前扫 `submodulepoppo/` 确认
pattern 集(见 Open decisions)。

---

## Phase 3 — confidence 模型

**目标**:纯模块。Phase 2 的 `SourceCandidate[]`(含 `kind`)+ `anchorNode` +
`foregroundActivity` + `ancestorChain` → `{confidence, reason, signals[]}`。

**Files**
- `server/src/source/confidence.ts` — Q7 演绎分级:前台 Activity cross-check
  为主导信号;`signals[]` 8 个布尔判据;`high/medium/low/none` 判据见 design
  lock § confidence 分级判据。
- `server/tests/source/confidence.test.ts` — table tests:唯一声明、多声明 +
  cross-check 消歧、RecyclerView 复用 cap、framework id、无锚点。

**Verify**:Vitest only。依赖 Phase 2.2 的 candidate 形状已定稿。

---

## Phase 4 — `android_debug_map_ui_node_to_source` tool

**目标**:Phase 2 + 3 接成 tool。

**Files**
- `server/src/mcp/tools/map_ui_node_to_source.ts` — input `{runId,
  anchorNode, foregroundActivity, ancestorChain}`;解析 `projectRoot`(缺失 →
  `project_root_missing`);跑 recipe + confidence;output `{confidence,
  reason, signals[], candidates[]}`;写 `source_mapping` 事件 +
  `commands.jsonl`。失败语义 Q9。
- `server/src/mcp/toolError.ts` — 加 `rg_not_found` / `search_timed_out` /
  `project_root_missing`。
- `server/src/mcp/bootstrap.ts` — 注册 `map_ui_node_to_source`;
  `TOOL_COUNT` 18 → 19。
- `server/src/mcp/constants.ts` — `ANDROID_DEBUG_TOOL_NAMES` 加
  `android_debug_map_ui_node_to_source`。
- `server/src/summary/render.ts` — `get_run_summary` 渲染 `source_mapping` 事件。
- `server/tests/mcp/map_ui_node_to_source.test.ts` — `rg` 缺失硬错、超时硬错、
  零命中软结果、`anchorNode:null` 软结果、`projectRoot` 缺失硬错。
- `server/tests/integration/tool_contract.test.ts` /
  `server/tests/mcp/register.test.ts` — tool 数 18 → 19;`Errors:` 描述列全。

**Delivers**:验收 scenario A 全段、C(歧义消解)、E(RecyclerView)。

依赖 Phase 2 + Phase 3。**audit checkpoint**(节奏 A):本 phase 完成后过 codex。

---

## Phase 5 — 验收 + fixture harvest + 回归 gate

**目标**:design lock 的 5 条验收 scenario 定稿 + 真机跑通;fixture 收齐;回归。

**Files**
- `docs/v2/source-mapping.md` § 验收 —— 草案定稿(若实施中判据要调,走翻案规则)。
- `server/tests/fixtures/ui/` —— 真机 Poppo dump 补齐。
- `server/tests/fixtures/source/` —— View 源码样本。
- `docs/v2/test-plan-v2a.md` —— 5 scenario 真机 manual checklist。
- 回归:`bun run lint && typecheck && test` 必绿。

**Verify(真机)**:Poppo 上跑通 5 条 scenario。

依赖 Phase 1 + Phase 4。**final audit**(节奏 A):本 phase 后 codex 终审。

---

## 并行计划

两条链基本独立:

- **链 T(tap_node)**:Phase 0 → 1
- **链 M(map)**:Phase 2 → 3 → 4

Phase 2 不碰设备、不依赖链 T,可与 Phase 0/1 并行(2.0 触及 v1 start_session,
独立先行亦可)。Phase 5 在两链都完成后启动。本计划默认单人串行实施
(2.0 → 0 → 1 → 2.1/2.2 → 3 → 4 → 5)。

## 关键路径风险

1. **Phase 0 uiautomator parser + hit-test** —— v2-A 单一最高风险。真机 dump
   的多 root(dialog)、`<merge>`、自定义 View、非法 bounds、等界平手。对策:
   tie-break 规则已在 Phase 0 写死 + fixture 先行。预算 ~35% 总工时。
2. **契约失败类风险(codex 提示,非 parser bug)**:
   - `projectRoot` provenance —— 若不持久化、从 `runRoot` 反推,违反 Q5 且
     post-hoc 映射会静默用错根。已在 Phase 2.0 处置。
   - 新硬错码不进 catalog / 不进 `Errors:` 描述 —— public contract 错。已在
     Phase 1/4 的 `toolError.ts` + 契约测试处置。
   - `bootstrap.ts` 的 `TOOL_COUNT` 与契约测试不同步 —— 已列入 Phase 1/4 Files。
3. **Phase 2 rg recipe 精度** —— ViewBinding snake→camel、`@+id` vs `@id`、
   `<include>` 的 id 归属。对策:fixture 源码树覆盖各形态。
4. **Phase 3 前台-Activity cross-check** —— `dumpsys` activity 名与 `R.layout`
   反查的对接;Fragment 场景前台 activity ≠ owner。confidence 据此降级而非误判。

## codex audit 节奏(锁定:A)

A = **Phase 1 后 + Phase 4 后 + 最终**,共 3 次。理由:final-only 太晚
(Phase 0 的 parser/hit-test bug 会污染所有 tap_node fixture);per-phase 过重
(Phase 2/3 是纯 map-chain 模块,Phase 4 一起审即可)。Phase 1 checkpoint 锁
runtime 观测地基;Phase 4 checkpoint 锁 source/confidence/tool 契约;最终验真机
验收 + fixture harvest。codex 与 orchestrator 评审一致选 A。

## Open implementation decisions(承接 design lock § Open)

design lock 已列 7 条;实施前需额外定:

1. **Phase 0** —— 多 root XML 的"最顶层窗口"如何从 XML 判定(window 层级标记 /
   节点序)—— fixture 观察后写死。
2. **Phase 2** —— Poppo 的 view binding 机制(ViewBinding / `findViewById` /
   DataBinding / 废弃的 kotlin synthetics)—— 实施前扫 `submodulepoppo/` 定
   pattern 集与 `SourceCandidate.kind` 集合。
3. **Phase 2.0** —— `projectRoot` 解析:仅 `git rev-parse --show-toplevel`,
   还是也接受 `start_session` 显式入参?默认仅 git-toplevel,非 git → `null`。
4. **Phase 4** —— `map` 的 `commands.jsonl` 记 `rg` 命令字面量,还是 tool 级
   摘要?默认记 `rg` 实际命令,对标 v1 `commands.jsonl` 语义。
5. **Phase 5** —— test-plan 独立 `docs/v2/test-plan-v2a.md`,还是并入 v1
   `test-plan.md`?默认独立。

## 关键文件清单(实施时优先 review)

- `server/src/ui/hierarchy.ts`
- `server/src/ui/hit_test.ts`
- `server/src/source/recipe.ts`
- `server/src/source/confidence.ts`
- `server/src/store/metadata.ts`(`projectRoot` 加性扩展)
- `server/src/mcp/bootstrap.ts`(注册面 + `TOOL_COUNT`)
- `server/src/mcp/tools/tap_node.ts`
- `server/src/mcp/tools/map_ui_node_to_source.ts`
