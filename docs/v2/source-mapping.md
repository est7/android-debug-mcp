# Android Debug MCP — v2-A Design Lock · Tap-to-Source

Locked: 2026-05-21. Derived from a grilling session (Q1–Q10) in this repo's
conversation history; codex served as design reviewer across two passes.
Promoted from [`../backlog.md`](../backlog.md) § v2-A per the docs promotion rule.

## 文档定位

v2-A = **UI 元素 → 源码 mapping(tap-to-source)**:把设备上一次 tap,映射到拥有
被点元素的源码位置。

本文件是 v2-A 的设计 lock,对齐 [`../design-lock-v1.md`](../design-lock-v1.md)
体例。v1 的 17 项决策与持久化格式仍然有效且不动;本文件只锁 v2-A 在 v1 之上
**新增**的部分。

## Baked-in assumptions(不上桌的前提)

1. v2 是一个聚焦 milestone,脊柱 = v2-A;其余 deferred backlog(auto-replay /
   多设备 / HTTP transport / bundle 上传 / element-based interaction)按依赖
   排队,不并行(Q1)。
2. 映射方向是**单向 runtime → source**。节点身份是 `uiautomator dump` 的运行时
   观测 —— `bounds`、运行时 view tree、哪个节点在坐标 (x,y) 下,源码库都给不出。
   源码库只是最后一跳(`resourceId` 字符串 → `file:line`)的 find 目标。
3. v2-A 在 v1 之上**新增 2 个 tool**(`android_debug_tap_node`、
   `android_debug_map_ui_node_to_source`),不改 v1 的 17 个 tool,不改
   `events.jsonl` / `commands.jsonl` 的持久化格式。
4. View `resource-id` 是 Android 默认产物,零工程前置;Compose 没有,要 testTag
   规范 —— 见实施分期。

## 实施分期

| Phase | 目标 | 前置 | 触发 |
|---|---|---|---|
| **Phase 1 — View-first** | Poppo / Vone。`坐标 → 节点 → resource-id → 源码` 解析链;在低误匹配基底上把 confidence 调出可信 baseline。**v2-A v1 即此阶段。** | 无(`resource-id` 已有) | 立即 |
| **Phase 2 — Compose-first** | popposhell。Compose 无 `resource-id`,节点身份靠 testTag / semantics。 | popposhell 组落地 testTag 工程规范 | Phase 1 跑出真实用量数据 + 规范达成共识 |

popposhell 的 Compose 重构是项目**已确定的未来方向**,v2-A 终局必然转向 Compose;
View-first 是把 testTag 规范这个**组织依赖**移出 milestone 关键路径,不是弃 Compose。

## 决策表(Q1–Q10)

### A. 范围与目标

| # | 决策 | 选定 |
|---|---|---|
| Q1 | v2 形态 | 聚焦 milestone,脊柱 v2-A;其余 backlog 排队 |
| Q2 | 第一目标 app | **View-first**(Poppo / Vone);Compose 为 Phase 2 |

### B. `android_debug_tap_node`(新 tool,inventory 第 18)

| # | 决策 | 选定 |
|---|---|---|
| Q3 | tap 与层级关联 | **原子 capture-then-tap**:pre-tap `uiautomator dump` → `input tap`,一次调用完成;坐标由 agent 提供;v1 的 `tap` 工具保持纯净不动 |
| Q4 | 命中节点选取 | 主锚点 = 从 leaf 往上**最近一个带非空、app 包名 `resource-id` 的节点**;全祖先链留作 context;无 `text` / `content-desc` fallback(code-driven i18n);framework / 包名不匹配的 id（`android:id/*`)不作锚点;RecyclerView 行 id 复用 → cap confidence |
| Q8 | 事件 schema | `tap_node` 事件 + `Node` 对象:去规范化、单事件自足、隐私轻量(见 Schema) |
| Q9 | 失败语义 | 见失败语义表 |

### C. `android_debug_map_ui_node_to_source`(新 tool,inventory 第 19)

| # | 决策 | 选定 |
|---|---|---|
| Q5 | 匹配后端 | **`rg` + 确定性 pattern recipe**;显式 `projectRoot`,排除 `build/` 等生成目录;保留原始命名空间、按 entry name 派生 pattern;LSP 推到 v3-B |
| Q6 | tool 边界 | **独立 tool**,device-independent、可事后跑、可纯单测;源码候选**不回填**进 append-only 的 tap 事件 |
| Q7 | confidence 模型 | **分级演绎**:`high` / `medium` / `low` / `none` + `reason` + 机读 `signals[]`;主导信号 = 前台 Activity cross-check;**不暴露 public 数值分**(可有 internal-only 排序键) |
| Q10 | 输入 schema | agent **直接传节点身份**(`events.jsonl` 无稳定 event-id,不做引用);`{ runId, anchorNode, foregroundActivity, ancestorChain }` |

### D. 失败语义(Q9)

判别原则:**这次调用能不能给出一个可信的答案?** 能(哪怕否定)→ 软结果;
不能(没跑成 / 没跑完)→ 硬错(`{isError:true}` + code)。

`android_debug_tap_node`:

| 失败模式 | 归类 | 返回 |
|---|---|---|
| 无 active session / 设备掉线 / `input tap` 失败 | 硬错 | `{isError, code}`(同 v1) |
| pre-tap `uiautomator dump` 失败 | 硬错,**tap 前中止(不点)** | `{isError, code:"ui_dump_failed"}` |
| 层级解析成功但无 app `resource-id` 锚点 | 软结果 | 正常事件,`anchorNode:null` / `anchorSource:"none"` |

`android_debug_map_ui_node_to_source`:

| 失败模式 | 归类 | 返回 |
|---|---|---|
| `runId` / 节点引用无效 | 硬错 | `{isError, code}` |
| `rg` 不在 PATH | 硬错 | `{isError, code:"rg_not_found"}` |
| `rg` 超时 / 未跑完 | 硬错,**绝不返回 partial** | `{isError, code:"search_timed_out"}` |
| `rg` 跑完零命中 / 传入 `anchorNode:null` | 软结果 | `{candidates:[], confidence:"none", reason}` |

`tap_node` 的 pre-tap dump 失败定为硬错 —— 这偏离 v1 `capture`(它把 `ui_dump`
失败当软的 `uiDumpPath:null`)。理由:dump-在-tap-前 的时序允许无副作用中止;
`tap_node` 的契约是"点 + 告诉你点了什么",拿不到层级不应制造无证据价值的副作用。
不静默 fallback 到裸 `tap` —— fail fast,agent 自己决定要不要改调普通 `tap`。

## Schema

### `tap_node` 事件(`events.jsonl`)

```jsonc
{
  ts,                          // append 层补,同 v1 所有事件
  type: "tap_node",
  x, y,                        // 对齐 v1 tap 的 x/y
  preTapCaptureId,             // tap 前一刻的 ui_dump;artifact 落 artifacts/ui-<id>.xml
  preTapForegroundActivity,    // dumpsys 前台 Activity,string | null
  tappedNode: Node,            // 最小包含节点 = 物理落点;直接命名字段
  anchorNode: Node | null,     // 源码映射主锚点(最近 app 包名 resource-id 节点);
                               //   完整对象,可能 === tappedNode,可能 null
  anchorSource: "tapped_node" | "ancestor" | "none",
  ancestorChain: Node[],       // tappedNode 之上的严格祖先,[直接父, …, root]
  label?
}
```

### `Node` 对象(隐私轻量 —— 无 `text` / `content-desc`)

```jsonc
{
  resourceId: string | null,   // "com.baitu.poppo:id/login_button";缺失为 null(非 "")
  class: string,
  package: string,
  bounds: { left, top, right, bottom },  // 整数
  index: number | null,        // 解析自 uiautomator;缺失为 null,不漏 stringly
  clickable: boolean,
  focusable: boolean
}
```

去规范化是刻意的:`events.jsonl` 写一次、被 agent 读多次,优化目标是**单事件自足**
(分页 / 摘录 / chat 引用里抽出一条仍信息完整)+ **常路零额外 IO**,不是写端存储
紧凑。`anchorNode` 与某个 `ancestorChain` 项重复 ≈ 7 个标量,可忽略。

### `android_debug_tap_node` I/O

- **input**:`{ runId, x, y, label? }`
- **output**:镜像事件身份 —— `{ ts, preTapCaptureId, preTapForegroundActivity,
  tappedNode, anchorNode, anchorSource, ancestorChain }`。**不能**像 v1 `tap` 只回
  `{ts}`,否则 agent 还要读 `events.jsonl` 才拿到 `anchorNode`,常路又付一次 IO。
- 同时产出:`artifacts/ui-<captureId>.xml`(完整层级,复用 v1 capture 机制)、
  一条 `{type:"capture", captureId, kinds:["ui_dump"]}` 事件、`commands.jsonl` 一条。

### `android_debug_map_ui_node_to_source` I/O

- **input**:`{ runId, anchorNode: Node|null, foregroundActivity: string|null,
  ancestorChain: Node[] }`。`runId` 用于解析 `projectRoot`,并把本次调用记成一条
  `source_mapping` 事件 + `commands.jsonl`。
- **output**(由 Q7 推导):`{ confidence, reason, signals[], candidates:
  SourceCandidate[] }`。`confidence` / `reason` / `signals` 是对这次解析整体的
  判定;`candidates` 是解析到的源码位置,确定性排序。

`signals[]` 取值(机读审计):`resource_id_present` / `resource_package_matches_session` /
`layout_declares_id` / `layout_inflated_by_foreground_activity` / `code_refs_found` /
`owner_ambiguous` / `framework_resource_id` / `recycled_row_id`。

confidence 分级判据:

| 档 | 判据 |
|---|---|
| `high` | id 唯一声明,或多处但恰有一处被前台 Activity inflate;且 screen owner 内找到 handler 引用 |
| `medium` | owner 解析出来,但无直接 handler(ViewBinding 隐式 / handler 在 adapter / base class) |
| `low` | id 多处声明 + 前台 Activity cross-check 仍无法消歧;或 RecyclerView 行复用主导 |
| `none` | 无 app 包名 `resource-id` 锚点;`rg` 缺失则是硬错,不是 `none` |

## rg 匹配 recipe(Q5)

从 `anchorNode.resourceId` 取 entry name(`login_button`),在 `projectRoot` 下:

- `@+id/login_button` → 布局 XML 的 id 声明处
- `R.id.login_button` / `findViewById` / ViewBinding camelCase（`loginButton`)→ 代码引用处
- 从布局文件名反查 `R.layout.activity_login` → inflate 它的 Activity / Fragment(screen owner)

约束:显式 `projectRoot`(不靠 cwd 猜);排除 `build/` 等生成目录(否则生成的 `R` /
binding 类淹没确定性候选);保留 `com.foo:id/bar` vs `android:id/bar` 命名空间,
只用 entry name 派生 pattern。

## codex 设计复审(2 轮,留痕)

codex 作为设计 reviewer 参与两轮,贡献已并入上方决策:

- **Q7**:在 `tier + reason` 外加机读 `signals[]`;数值排序键 internal-only。
- **Q3**:正式钉死 pre-tap 层级 + 独立富事件(非"capture + 老 tap + 打补丁")。
- **Q4**:framework / 包名不匹配 id 排除作锚点;RecyclerView 行 id 复用 cap
  confidence;`content-desc` 同 `text` 一并不作 fallback。
- **Q5**:显式 `projectRoot`、排除生成目录、保留命名空间。
- **Q6 / Q8**:节点身份隐私轻量,`events.jsonl` 不持久化运行时 `text` / `content-desc`。
- **Q8**:tool 返回值必须镜像事件身份;加 `anchorSource`;`index: number|null`、
  bounds 整数。

codex 总结的三大设计风险:pre-tap vs post-tap 时序歧义、过度信任 framework /
复用 id、翻译后运行时文本泄进事件身份 —— 三条均已在决策中处置。

## 验收 scenario(5 条)

5 条 scenario 锁 v2-A 链 T + M 的**可信证据形状**,是 contract;具体运行步骤(导航、坐标、env)推到 [`test-plan-v2a.md`](./test-plan-v2a.md)。每行 4 列:

- **invariant** — 这条 scenario 守的核心不变量。
- **observable outputs** — `tap_node` / `map` 返回值必须命中的字段约束。
- **required `signals[]`** — `map` 返回的 `signals[]` 必须包含的位(机读审计;`map` 硬错路径不返 signals)。
- **candidate kind / error** — `map` 的 `candidates[]` 必须含有的 `kind` 集合,或对硬错 scenario 而言必须返回的 error code。

| # | invariant | observable outputs | required `signals[]` | candidate kind / error |
|---|---|---|---|---|
| A | 带 app-package `resource-id` 的可点节点能映射到其 owner | `tap_node`:`anchorNode != null`、`anchorSource ∈ {tapped_node, ancestor}`<br>`map`:`confidence: "high"` | `resource_id_present`、`resource_package_matches_session`、`layout_declares_id`、`code_refs_found` | `id_declaration` + `screen_owner` + `code_ref` 至少各一条;命中的 `code_ref` 与 resolved `screen_owner` 同文件 |
| B | 无 app-id 锚点 → 不映射、不误报 | `tap_node`:`anchorNode: null`、`anchorSource: "none"`<br>`map`:`confidence: "none"`、`candidates: []` | (空) | — |
| C | id 多 layout 声明时,前台 Activity cross-check 消歧 | `map`:`confidence ∈ {high, medium}`;`signals[]` 不含 `owner_ambiguous` | `resource_id_present`、`resource_package_matches_session`、`layout_declares_id`、`layout_inflated_by_foreground_activity` | ≥2 条 `id_declaration` 候选;`screen_owner` 中恰好一条 simple class name 等于前台 Activity simple class name |
| D | 失败语义硬错且无副作用 | sub-a(pre-tap dump fail):`tap_node` `{isError: true}` + run 内不写 `tap_node` 事件 + 不发 `input tap`<br>sub-b(`rg` 缺失):`map` `{isError: true}` + run 内不写 `source_mapping` 事件 | (硬错不返 signals) | sub-a:`ui_dump_failed`<br>sub-b:`rg_not_found` |
| E | RecyclerView / ListView / GridView 行内 id 复用 cap confidence | `map`:`confidence: "low"`,`reason` 提示 recycled row | `recycled_row_id` + `resource_id_present` + `resource_package_matches_session` + `layout_declares_id` | ≥1 条 `id_declaration`;`recycled_row_id` 主导降级,与 `owner_ambiguous` 无关 |

## Open implementation decisions(实施时定形)

1. ✓ **resolved (Phase 2.2)** — `map` 输出 `candidates` 的 `kind` 分类:`id_declaration` / `screen_owner` / `code_ref` / `generated_noise`,字段 `{file, line, kind, text}`(`server/src/source/candidate.ts`)。
2. **still open** — `ancestorChain` 截断规则。真机 Poppo dump 至今未见病态深度,暂不实施(`ancestorChainTruncated:true` 字段未引入)。
3. ✓ **resolved (Phase 2.1, commit `d0ebcaa`)** — Poppo 是 ViewBinding-only(无 `findViewById`、无 kotlin synthetics、DataBinding 声明未用);screen-owner recipe pattern 集见 [`v2-a-implementation-plan.md`](./v2-a-implementation-plan.md) § 2.1。
4. ✓ **resolved (Phase 2.1)** — snake_case → lowerCamelCase 在 `server/src/source/recipe.ts`(`face_mask_top` → `faceMaskTop`,已是 camel 则保留)。
5. ✓ **resolved (Phase 1 / 4)** — 硬错码进 `server/src/mcp/toolError.ts` typed catalog(`ui_dump_failed` / `rg_not_found` / `search_timed_out` / `project_root_missing`);每个 tool 的 `Errors:` 描述列全。
6. ✓ **resolved (Phase 1 / 4)** — `bootstrap.ts` `TOOL_COUNT` 17 → 18 → 19;`ANDROID_DEBUG_TOOL_NAMES` 同步两个新 tool。
7. ✓ **resolved (Phase 5)** — 验收 scenario 5 条定稿见 § 验收;运行步骤推 [`test-plan-v2a.md`](./test-plan-v2a.md)。

## 显式 out-of-scope(v2-A 不做)

- Compose / testTag 映射(Phase 2)
- element-based tap("点文本为 Login 的按钮")—— v2-F
- 自动 UI 复现 / replay —— v2-B
- LSP / JetBrains MCP / Kotlin PSI 索引 —— v3-B
- `getevent` 监听物理 tap(人手点屏)—— v2-A 后续增量,非首版
- 数值 confidence 分 / 跨候选 ranking 算法

## 翻案规则

同 v1:本文件 lock 后不就地改。v2-A 实施中若某决策需翻案,新增 amendments 段记录
原决策、新决策、触发原因、影响范围,并同步 [`../README.md`](../README.md) 索引。
