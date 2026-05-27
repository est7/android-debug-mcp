# Android Debug MCP — v2-F.1 Design Lock · Screenshot Element Annotate

Locked: 2026-05-27.
Derived from a thread on Google Android CLI's `screen capture --annotate` overlap
analysis(2026-05-27)+ Jimp vs sharp vs hand-rolled spike(`bun --compile`
compatibility 三方对比)+ 7-segment digit renderer spike(visual sign-off on
Poppo 隐私设置截图 fixture)+ codex pre-impl grill round 1(2026-05-27,
`STOP` on (a) fabricated `elementId` contract and (b) `annotateError` missing
from output schema —— 两条 blocking fold in 本 lock 的 v2 修订,详见 §
Amendments 2026-05-27 Round 1)。Promoted from [`../backlog.md`](../backlog.md)
§ 2026-05-27 v2-F.1 candidate(下方落 backlog 时一并新增条目)。

## 文档定位

v2-F.1 = **screenshot 元素标注**:`capture` 在拿到 PNG 之后,可选地把当前屏上的
元素(同 `list_elements` recipe 产出)全部用带编号的彩色 box overlay 到 PNG 上,
生成第二张 annotated screenshot;**同时**把"badge 编号 → 元素 center 坐标"的
mapping 平铺进 `capture` 响应(`annotation.elements`)。Agent 看图选编号
→ 直接读 mapping 拿 center → 调 v1 `tap` / v2-A `tap_node({runId, x, y})`,
**不必再开 round-trip 调 `list_elements`**。

**Badge 编号 = response-local `annotationId`(1-based,仅当次 capture 有效)**,
NOT global `elementId`。这是 codex round 1 STOP 的 #1 修复:v2-F.0 lock 显式
anti-cache,不存在跨 tool 的 element-id 契约;annotate 不可发明一个。

**v2-F.0 不动**(`list_elements` / `tap_node` / `long_press` / `tap` / `swipe` 全
保留契约);v2-F.1 仅给 `capture` 加 1 个 optional input 字段 + 1 个 optional
output nested `annotation` 对象。**不引入新 tool。**

## Baked-in assumptions(不上桌的前提)

- Agent loop 第一价值 vector 是 `视觉 → 决策 → 行动`(see → reason → act)。
  annotate 把"视觉编号与元素 center 的关联"从 agent 脑链(看图猜 / 比 JSON
  / 再调 `list_elements`)挪到 server pre-rendered overlay + same-response
  mapping,削减 1 步 saccade + 1 次 round-trip
- Badge 内容 = 纯数字 annotationId(response-local);**element 的 text / class
  / resourceId 不画在图上**(太多/太挤;agent 可从同响应的
  `annotation.elements[i]` 拿,字段与 v2-F.0 `Element` 等价)
- 同步阻塞 = OK:annotate 是 capture 的 in-process post-step(~100-200ms 增加),
  不开新 tool round-trip
- **annotationId ≠ elementId**:v2-F.0 lock 显式 anti-cache,不存在 server 端
  element-id 跨 tool 持久化。annotationId 是 1-based 顺序、**仅当次 capture
  响应内有效**;agent 拿编号要立刻读同响应的 mapping 用 center 坐标 act
- annotate 失败**不让 capture 失败**;screenshot 仍照常产出,nested `annotation`
  对象 `screenshotPath: null` + `error: "..."` + `elements: []`
- bunfs / `bun --compile` 兼容是硬约束(1.1-A backlog 上线时必须工作)
  → 选择**程序化 7-segment + pngjs**,不用任何 native dep / font 文件 / atlas 资产
- pngjs 解码前必须查 `width × height` 与 `bitDepth × channels` 上限,防 decode
  bomb 撑爆 memory(codex round 1 #8)

## 决策表(Q1–Q12)

### A. 范围与契约形态

#### Q1:annotate 是 `capture` 的扩参,还是 `kinds` 的新值,还是新 tool?

**Decision: `capture` input 加 `annotateElements?: boolean`(default `false`)。**

- 不另开 tool:annotate 永远跟 screenshot 是一对儿;另开 tool 是无谓的 round-trip
- 不进 `kinds` enum:`kinds` 当前是 `"screenshot" | "ui_dump"`,两条都是
  **独立产物**;annotate 不是独立产物 —— 它**依赖** screenshot,加进 kinds 会
  错配语义("annotate 不带 screenshot 怎么办" → 校验拒绝 → 用户疑惑)
- 选 boolean 而非 `"annotateScreenshot" | "annotateScreenshotAndUiOverlay"`
  等枚举:v1 只有"画 vs 不画"两态,过度建模

```ts
// inputSchema 增量(strict 仍保):
annotateElements: z.boolean().default(false).optional()
```

#### Q2:何时 reject?

**Decision:`annotateElements: true` 而 `kinds` 不含 `"screenshot"` → `query_malformed`。**

- 没有 screenshot 就没东西可 annotate。强约束在 input schema 层(`.refine()` →
  ZodEffects 不能进 inputSchema § G-4),所以**校验放 handler 内**,throw
  `ToolDomainError("query_malformed", ...)` 与 v0.4.0 narrowing-filter 处理一致

#### Q3:annotated PNG 落哪、叫什么?

**Decision:`<artifactsDir>/screenshot-<captureId>-annotated.png`。**

- 紧贴 `screenshot-<captureId>.png` 命名,grep 即可 pair
- 不替换原 screenshot:`agent` / `bundle` / 后续 read 工具仍能拿原 PNG;
  annotated 是**额外**资产
- 不进 `metadata.json`:capture 产出本来就不进 metadata(走 `events.jsonl`
  capture event)

### B. Element 来源与 identity

#### Q4:element 列表怎么拿?是 internal `list_elements` 还是让 agent 传?

**Decision:internal —— `capture` 在 annotate enabled 时自己跑 list_elements 的
recipe(共用 `server/src/ui/elements.ts` 或等价模块,§ v2-F element-interaction.md
§ "element 收集 recipe (Q5)"),不让 agent 传 element 列表。**

- 让 agent 传 = 多一次 round-trip + agent 可能传过期的列表(屏幕已变)
- internal 调用 = annotate 用的 element list 与 `list_elements` 返的一致(同
  recipe → 同 collect 顺序 → 同 `annotationId` 在同响应内绑定同 `center`),
  contract 闭合 —— 注意 annotationId 只 in 当次响应有效(§ Q5),不跨 tool
- 性能:list_elements 已经在 v2-F.0 跑过 acceptance,~200ms;annotate 在它后面
  跑 ~150ms = 总增量 ~350ms,可接受

#### Q5:badge 编号是什么?如何让 agent 把编号转成可调用的坐标?

**Decision:badge 编号 = response-local `annotationId`(1-based 数字,仅本次
capture 响应内有效)。agent 从同响应的 `annotation.elements[i]` 拿 `center`
+ `bounds` 直接调 v1 `tap` / v2-A `tap_node({runId, x, y})`,不发明跨 tool
的 `elementId` 契约。**

- 否决"badge 编号 = global elementId"(原 lock):v2-F.0 显式 anti-cache,
  `Element` 无 id 字段,`tap_node` 无 `elementId` 入参(`tools/tap_node.ts:57-76`
  入参是 `{runId, x, y, label?}`),无端发明会让 agent 按图发 invalid call。
  codex round 1 #1 blocking 抓
- 实现:annotationId = 共享 `collectElements` recipe 产出顺序的 1-based index
  (元素列表确定后立刻冻结,作为本次 capture 响应的 source of truth)
- 失效场景:annotationId 不跨调用有效。下一次 `capture` 重新出号(列表重 collect
  ID 不保证延续)。这与 v2-F.0 lock 完全自洽(annotationId 是 response-local
  指针,不假装是全局 identity)
- 与 v2-F.0 `Element` 字段并存:`annotation.elements[i]` MUST 包含
  `{annotationId, center, bounds, ...}` —— `center` / `bounds` 形态与 v2-F.0
  `Element` 一致,这样 agent 学一套就够

#### Q6:annotationId 上限?3-digit 怎么办?

**Decision:badge 渲染支持任意位数,无人为 hard cap。**`list_elements` 实测
最大 ~80 elements/屏。3-digit fallback 走"badge 比 bbox 大就 outside"路径(Q9)。

### C. 渲染契约

#### Q7:glyph 技术?

**Decision:程序化 7-segment renderer,digits 0-9 only。**

- 否决 TTF runtime(opentype.js + 自写 scanline ~200 LOC + 150 KB lib + 灵活性
  对 ID label 无价值)
- 否决 bitmap font atlas(.fnt / BDF 文件嵌资产,bunfs 路径解析坑见 Jimp spike)
- 否决 Jimp / sharp font system(`bun --compile` 下 native dep / font path 双坑)
- 7-segment = 每个数字由 0-7 个固定 segment 组成,segment map 写死在源码 const
  (~30 LOC),draw 时按 segment 调 fillRect。size 改 `{width, height, thickness}`
  3 个数即可,无重新生成
- 字号:v1 固定 `digit = {w:24, h:40, thickness:6}`(badge 文字高 ~40px),
  badge padding `{padX:10, padY:8}` → badge 高 ~56px,宽随 digits 数 = 1 digit
  ~44px / 2 digits ~72px / 3 digits ~100px

#### Q8:color palette?

**Decision:固定 10 色硬码,按 `elementIdx % 10` 循环。**

```ts
const COLORS = [
  [0xff, 0x00, 0x44], [0x00, 0xcc, 0x66], [0xff, 0x88, 0x00],
  [0x99, 0x33, 0xff], [0x00, 0xbb, 0xdd], [0xdd, 0x22, 0x66],
  [0x44, 0xaa, 0x00], [0xee, 0x55, 0x00], [0x66, 0x44, 0xaa],
  [0x00, 0x88, 0x66],
];
```

- 10 色:足以覆盖一屏视觉区分(同色 element ≥ 10 个距离时,人/agent 不会混)
- 高对比 hue:每色 saturation ≥ 0.7,与白文字 contrast ≥ 4.5:1(WCAG AA),
  在浅色 / 深色背景上皆可读
- 不让 user override(v1):YAGNI;v2 视真实使用再加 `palette?: string[]` 参数

#### Q9:badge placement?

**Decision:inside top-left 默认 + outside top-left fallback when badge too big。**

```
inside fits if: (badgeW + 2*inset) <= 0.5*bboxW && (badgeH + 2*inset) <= 0.5*bboxH
else:           outside top-left, clamped to viewport (max(0, t - badgeH))
```

- inside default 解决 nested 元素 badge 堆叠问题(card→button→icon 三层 badge
  在 card 外左上挤一团 vs inside 各自 bbox 内独立位置 § 2026-05-27 spike 验证)
- outside fallback 解决小元素(status bar icon / 短 row toggle)装不下 badge
- inset = 6px:badge 不贴 bbox 边
- collision avoidance(badge 撞 badge)**不做**(Q12)

#### Q10:badge 形状 / 背景?

**Decision:实色矩形(badge color)+ 白文字。无 stroke、无 shadow、无半透明。**

- 实色保证文字可读(任何底色都不影响 badge 内部)
- 不做 shadow:多一道 alpha blend、视觉差异微小、bunfs 不增 dep 原则下不必要

#### Q11:bbox 边框?

**Decision:4px stroke,同 badge color。**

- 边框 + badge 同色 = 一眼归属(badge 是 id 标签,box 是 id 的位置)
- 4px:在 1080p 上明显但不夸张,sub-像素 alias 在 integer-only fillRect 下也
  整齐

#### Q12:badge-vs-badge collision avoidance?

**Decision:v1 不做,留 v2-F.2 触发条件。**

- 复杂度:为每个 badge 计算其矩形 region,与已绘 badge 列表算重叠,若重叠则
  按 inside-tr / inside-bl / inside-br / outside-tl / outside-tr ... 5 档循环
  fallback —— ~80 LOC + 一组 collision 拓扑 fixture 测
- 触发条件:agent 实测反馈"badge 撞在一起认不清",或者一屏 element 密度持续
  > 30 触发可见问题
- v1 接受"两个 badge 撞了 → agent 看 `list_elements` JSON 拆开"的退化路径

## Schema

### `capture` 输入扩参

```ts
const inputSchema = z.object({
  runId: runIdInput,
  kinds: z.array(z.enum(["screenshot", "ui_dump"])).min(1).max(2),
  label: z.string().min(1).max(200).optional(),
  // v2-F.1 新增。default false 保 v2-F.0 行为不变。
  annotateElements: z.boolean().default(false).optional(),
}).strict();
```

### `capture` 输出扩字段(nested,codex round 1 #2 修复)

```ts
// v2-F.0 Element FULL spread + annotationId prepended. Authoritative
// definition: `server/src/ui/list_elements.ts:23-44` (also documented in
// `docs/v2/element-interaction.md § Element 对象`). Spread is verbatim:
// no field rename, no omission, no addition. Codex round 2 #3 — lock the
// exact shape NOW so Phase 1 has no degree of freedom on public response.
// Field list intentionally NOT re-enumerated in this comment (would drift
// from source); read source for the canonical set.
const annotationElementSchema = z.object({
  annotationId: z.number().int().positive(),
  // ...Element — re-declared here for schema clarity; MUST stay byte-equivalent
  // to v2-F.0 ElementSchema (`server/src/ui/list_elements.ts:23-44`). If
  // v2-F.0 Element changes, this MUST follow in the same commit (no quiet drift).
  resourceId: z.string().nullable(),
  class: z.string(),
  package: z.string(),
  text: z.string().nullable(),
  contentDesc: z.string().nullable(),
  hint: z.string().nullable(),
  bounds: z.object({
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
  }).strict(),
  center: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
  clickable: z.boolean(),
  focusable: z.boolean(),
  checkable: z.boolean(),
  windowIndex: z.number().int().nonnegative(),
  // True-only optional state booleans — v2-F.0 lock § Element schema:
  // "false 这里会让 LLM 误以为有意义的 state",所以 absent != false。
  focused: z.literal(true).optional(),
  selected: z.literal(true).optional(),
  checked: z.literal(true).optional(),
}).strict();

const annotationSchema = z.object({
  // Present only when annotateElements was requested. Refine invariants
  // (codex round 2/3 — encode in zod, not docs alone):
  //   (a) screenshotPath:null ⇔ error:string   (bi-directional)
  //   (b) screenshotPath:string ⇔ error:null   (mirror of a)
  //   (c) error:string ⇒ elements:[] ∧ elementCount === 0
  //   (d) elementCount === elements.length    (success and failure, all cases)
  screenshotPath: z.string().nullable(),
  elementCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  elements: z.array(annotationElementSchema),
}).strict().refine(
  (a) =>
    (a.screenshotPath === null) === (a.error !== null) &&
    (a.error === null || (a.elements.length === 0 && a.elementCount === 0)) &&
    a.elementCount === a.elements.length,
  {
    message:
      "annotation invariants violated (screenshotPath ↔ error, error ⇒ empty, elementCount ≡ elements.length)",
  },
);

const outputSchema = z.object({
  captureId: z.string(),
  capturedAt: z.string(),
  screenshotPath: z.string().optional(),
  uiDumpPath: z.string().nullable().optional(),
  uiSummary: uiSummarySchema.nullable().optional(),
  // v2-F.1 nested. Undefined = annotate not requested. Present-and-error
  // = soft-degrade (screenshot still in `screenshotPath` above).
  annotation: annotationSchema.optional(),
}).strict();
```

**Why nested object,非平铺 `annotatedScreenshotPath` + `annotatedElementCount`
+ `annotateError`(codex round 1 #2 修复理由):**

- 平铺多 nullable-optional 字段散在 top-level 易混(`annotatedScreenshotPath: null
  + annotatedElementCount: undefined + annotateError: "..."` 这种组合无法明确
  存在性 ↔ 状态的对应)
- nested `annotation` 用 `undefined` 表示"未请求"、字段全员 in 状态对内自洽
  (`screenshotPath:null` ⇔ `error: <string>`,`screenshotPath: <path>` ⇔
  `error: null`)
- 把 `elements: [...]` mapping 放进同对象,语义聚集 —— annotate 是一组**关联**
  产出(图 + mapping + 状态),不是三个独立字段

### `capture` 事件 (`events.jsonl`)

```jsonc
// v2-F.0 (unchanged):
{ "type": "capture", "captureId": "...", "kinds": ["screenshot"], "label": "..." }

// v2-F.1 increment, only when annotateElements requested:
{
  "type": "capture",
  "captureId": "...",
  "kinds": ["screenshot"],
  "annotated": true,                  // requested
  "annotatedElementCount": 12,        // mirrors annotation.elementCount
  "annotateError": "...",             // present only when annotation soft-degraded
  "label": "..."
}
```

## 失败语义

| 触发 | 反应 |
|------|------|
| `annotateElements: true` 但 `kinds` 不含 `"screenshot"` | `query_malformed`(handler-side throw)—— 与 v0.4.0 Block A narrowing-filter handler-side check 同模式(`.refine()` 进 inputSchema 被 § G-4 拒) |
| `screencap` 失败 | 既有 `adb_command_failed`,annotate 不评(无 PNG)|
| `list_elements` recipe 失败(UI dump 不可用 / parse error) | `annotation: {screenshotPath:null, elementCount:0, error:"annotate_elements_unavailable", elements:[]}`,**tool 不 throw**;screenshot 仍正常返 in `outer.screenshotPath` |
| `list_elements` 返 0 元素(屏上无可识别 element) | `annotation: {screenshotPath:<path>(原图副本), elementCount:0, error:null, elements:[]}`,**不 warn** |
| pngjs decode 原 PNG 失败 | `annotation: {screenshotPath:null, ..., error:"annotate_decode_failed", elements:[]}`,tool 不 throw |
| PNG dimension > guard 上限(防 decode bomb,§ Baked-in assumptions)| `annotation: {screenshotPath:null, ..., error:"annotate_image_too_large", elements:[]}`,tool 不 throw。guard 上限由 Phase 1 实施时定(`Open implementation decisions`)|
| pngjs encode 写文件失败 | propagate IO 错(罕见 disk full / permission),tool throw |

**核心契约**:annotate 是 capture 的 additive value,**不是核心产出**。soft-degrade
原则贯穿:除 input rejection 和真 IO 错外,annotate 一切失败都让 `outer.screenshotPath`
拿到原 PNG,annotation 对象用 `error` 字段告诉 agent 为何降级,agent 可选择
退化到 v2-F.0 老链路(单独调 `list_elements`)。

## 与 v1 / v2-F.0 衔接

- v1:无影响。`capture` 老形态完全保留;不传 `annotateElements` = false = 老行为
- v2-F.0:annotate 是 `capture` 的 additive value,**不是**第二条按 identity
  操作元素的路径。`list_elements` recipe 内部共用 → annotate 与 `list_elements`
  返同顺序的 element list → agent 链路:`capture({annotateElements:true})` →
  看图选 annotationId → 读同响应 `annotation.elements[i].center` →
  v1 `tap({x,y})` / v2-A `tap_node({runId, x, y})`。**整条链路不出现 elementId**
- v2-F.0 acceptance fixture(test-plan-v2f.md scenario 列表)不变;新加 v2-F.1
  fixture 不重叠

## v2-F.1 实施分期

| Phase | 范围 | 工程量 |
|---|---|---|
| 1 | `pngjs` 依赖加入 + `server/src/annotate/{glyphs,paint,annotate}.ts`(3 文件)+ 内部 unit test(glyph snapshot + paint primitives) | 0.5 天 |
| 2 | `capture.ts` 扩 input/output + handler-side annotate orchestration + integration test(fixture screenshot + 合成 element list → golden snapshot PNG diff) | 0.3 天 |
| 3 | design doc(本文)+ pre-impl codex grill 一轮 | 0.2 天 |
| 4 | post-impl codex audit 一轮 | 0.2 天 |
| 5 | bump 0.4.1 → 0.5.0(feature minor)+ commit + tag | 0.1 天 |

**总 ~1.3 天。**

## 验收 scenario(spike 已验,v1 沿用 + 加 unit + 加 mapping 验证)

- **S1**:固定 fixture PNG(1080×2400 Poppo 隐私设置截图)+ 12 合成 element 列表
  (含 nested + 顶 / 底边缘 + 短 row + 3-digit id)→ (a) golden snapshot PNG
  diff(`annotation.screenshotPath` 指 PNG)+ (b) `annotation.elements` 长度
  == 12 + (c) 每个 `annotation.elements[i].annotationId == i+1` + (d) 每个
  element 的 `center` / `bounds` 与同合成 fixture 一一对应
- **S2**:`list_elements` 返 0 元素 → `annotation.screenshotPath` 指 PNG(原图
  byte-identical 副本)+ `annotation.elementCount == 0` + `annotation.elements
  == []` + `annotation.error == null`
- **S3**:`list_elements` recipe throw → `annotation.screenshotPath == null` +
  `annotation.error == "annotate_elements_unavailable"` + tool 不 throw +
  `outer.screenshotPath` 仍是 PNG
- **S4**:`annotateElements: true` + `kinds: ["ui_dump"]` → `query_malformed`,
  tool throw,无 capture 产物落盘
- **S5**:`annotateElements` 未传 → 既有 v2-F.0 输出形态完全等价(无 `annotation`
  字段)
- **S6**:3-digit annotationId badge 大于 0.5 × bbox → 该 badge fallback 到 outside
  top-left(其他正常 inside)
- **S7**:inside placement,顶行 bbox(t=0)→ badge 在 bbox 内,无越屏
- **S8(codex round 1 加)**:agent 用 `annotation.elements[i].center.{x,y}` 作为
  入参调 `tap_node({runId, x, y})` —— assert tap 命中同 fixture 对应位置,验证
  "annotate 自包含 mapping"契约,不需第二次 `list_elements`
- **S9(codex round 1 加)**:超大 PNG(超 guard dim)→ `annotation.error ==
  "annotate_image_too_large"`,tool 不 throw,memory 不溢
- **S10(codex round 1 加 / round 2 改写)**:同一 fixture 重复调 capture
  (annotateElements:true)两次,assert 两次 `annotation.elements[i]` 的 `center`
  / `bounds` 相同(recipe 确定性)。**annotationId 不在 assertion 范围内** ——
  collect 顺序确定 ⇒ 同 UI 下 annotationId 实际相同,但这是 collection-order
  determinism 的副作用,**不是契约的一部分**;agent 不可基于"上次 capture 看到
  21 就是这个元素"做跨调用决策(v2-F.0 anti-cache lock + Q5)。assertion 应改为
  "for an unchanged fixture, the response-local numbering is deterministic
  because collection order is deterministic; this remains non-identity and must
  not be reused across calls"

## 显式 out-of-scope(v2-F.1 不做)

- badge-vs-badge collision avoidance(Q12,留 v2-F.2)
- 可配置 palette / glyph 字号(Q8 / Q7)
- 非数字 label(text / icon / 自定义 label)
- 半透明 badge 背景(Q10)
- TTF / atlas 字体(Q7,bun --compile bunfs 约束所致)
- Element subset filter(`annotateElementIds?: number[]`)—— 如真 case 出现
  再加,v1 全画
- Annotated PNG in-place replace 原 screenshot(总是产 sibling 文件)
- anti-aliased glyph(Q7,7-segment integer-pixel 无 AA)
- 自动放大字号到 retina 屏:agent 拿到的 PNG 缩放是 client 端事
- 多语言 / RTL 文字(v1 纯数字,无语言概念)

## Open implementation decisions(实施时定形)

- **element 收集共享 helper**(codex round 2 #4 修订 signature):

  ```ts
  // server/src/ui/list_elements.ts (or sibling helper module)
  export async function collectCurrentElements(
    session: ActiveSession,
    uiDumpPath: string,  // caller owns path naming + captureId 绑定
  ): Promise<{
    elements: Element[];
    windowCount: number;  // list_elements 公共 output 也用,共享 source of truth
  }>;
  ```

  Caller 责任划分:
  - **handler 拥有**:`captureId` 铸造、`ui-<captureId>.xml` 文件名、`appendCommand`
    / `appendEvent`、tool-specific 返回 shape(`list_elements` 返 `{elements,
    windowCount}`;`capture+annotate` 返 `annotation` nested object)
  - **helper 只做**:`captureUiDump → parseUiHierarchy → collectElements`,
    返 `{elements, windowCount}` 或 typed error
  - **严禁** `capture` 内部去调注册的 `list_elements` tool handler(event/privacy
    语义会错绑两次)

  **重要文档化**:`capture({annotateElements:true, kinds:["screenshot"]})` 也
  会内部写一份 UI dump 到 `<artifacts>/ui-<captureId>.xml`(helper 需要 path
  入参),**即使 `kinds` 没要 `ui_dump`**。这一写入要在 `events.jsonl` 的
  capture event 明确(`annotated:true` 隐含 internal UI dump artifact),
  让 agent / 后续 bundle 不被无标 artifact 困惑

- **PNG decode-bomb guard 上限**(codex round 2 #3 修订):
  - 常量名 `MAX_PIXELS`,值 = **`16_777_216`**(= 4096²)。**精确等于 4K × 4K**,
    不再写"16M 约等于"。`bitDepth <= 16`,`channels <= 4` 同上限
  - 任一项超 → `annotate_image_too_large`,tool 不 throw
  - guard 必须读 **IHDR header(前 29 字节,= `IHDR_HEADER_BYTES`)** 拿
    `width / height / bitDepth / colorType`,**先 reject 再 decode**;若同时
    校验 CRC,再读 4B = 33B。绝不允许 `PNG.sync.read(fullBuffer)`
    完成后再检查 dim —— 那时 RAM 已经分配
  - pngjs API:`new PNG().parse(buf, cb)` 是异步且 streaming,但 sync 路径
    `PNG.sync.read` 一把吃完。Phase 1 用 IHDR 前置 parse(手 read header bytes)
    + 通过后再调 `PNG.sync.read` 全解码。具体 IHDR layout:`\x89PNG\r\n\x1a\n`
    8B magic(`\x89PNG\r\n\x1a\n`)+ 4B chunk length + `IHDR` 4B chunk type
    + 13B IHDR data(width:4 height:4 bitDepth:1 colorType:1 compression:1
    filter:1 interlace:1)= **29 B**(不含 CRC,够取所有 guard 所需字段);
    若顺手读 4B CRC 一并校验 = 33 B。Phase 1 实施时 const `IHDR_HEADER_BYTES = 29`
  - 上限以 const 在 `server/src/annotate/paint.ts` 顶部定义,可后续调整
- **golden snapshot 测试 driver**:vitest + `pngjs.sync.read` byte 比较;失败
  时把实际 PNG 写到 tmp 让人眼对。环境变量 `UPDATE_GOLDENS=1` 重写 golden
- **fixture 文件 size**:固定 fixture 应控在 ~300KB 以下(避免 repo 膨胀)

## 设计复审决策(provenance,留痕)

待 pre-impl codex round 1 review。

## 翻案规则

任何 Q1–Q12 决定要翻 → 必须先写 `## Amendments` 段注明触发 case + 复审者 +
新决策 + 与既有 acceptance scenario 的兼容性影响,**不准默默改**。

## Amendments

### 2026-05-27 · Codex pre-impl grill round 1 — STOP fold-in

Reviewer: codex(via orchestrator `collab` thread `design/v2-F.1-annotate`,
msg id `2026-05-27T09-53-21.436Z_pid1553_3a527e21`,kind `review_response`)。

Verdict: `STOP`,两条 public-contract blocker。Fold-in 直接修订 v1 文本(下面
列原决策 vs 修订决策的对照,**不是事后补丁**):

**#1(Q1/Q5 重写):** 原 v1 lock 写 "badge 编号 = global `elementId`,agent 看
图调 `tap_node({elementId})`"。Codex 抓出 `tap_node` 当前入参是 `{runId, x, y,
label?}`(`server/src/mcp/tools/tap_node.ts:57-76`),`list_elements` 返的
`Element` 无 `id` 字段,v2-F.0 `element-interaction.md:272-273` 显式 anti-cache。
按原 v1 上线 → agent 按图发 invalid `tap_node({elementId})` call,annotate 输出
也未附 center 坐标 → agent loop 彻底 poisoned。

修订:badge 编号 = response-local `annotationId`(1-based),annotate 把
`elements: Array<{annotationId, center, bounds, ...}>` 一起塞进 `capture` 响应,
agent 读 mapping 拿 `center` 直接调 v1 `tap({x,y})` 或 v2-A `tap_node({runId,
x, y})`。**附加价值**:annotate 顺手把"调一次 capture 拿图 + mapping"合一了,
省了 v2-F.0 老链路必须调第二次 `list_elements` 的 round-trip。

**#2(schema 重构):** 原 v1 写 "soft-degrade 时 `annotatedScreenshotPath: null`
+ `annotateError: <string>`",但 outputSchema 平铺只声明 `annotatedScreenshotPath
+ annotatedElementCount`,没声明 `annotateError`。`server/src/mcp/register.ts:103-109`
对每个 success payload 跑 `outputSchema.parse(...)` strict 校验 → 实现 path:
要么把 `annotateError` 加进 payload(被 strict reject 当 impl bug)、要么不加
(agent 只看到 null 无 reason,soft-degrade 退化成静默失败)。

修订:把 annotate 三字段(screenshotPath / elementCount / error / elements)
都集进 nested `annotation` 对象,`annotation?: { screenshotPath: string|null,
elementCount: number, error: string|null, elements: [...] }.strict()`。
nested 对内自洽,平铺多 nullable-optional 撒在 top-level 的"存在性 ↔ 状态
组合"难枚举的问题不复存在。

**#8 修正:** pngjs `7.0.0` 发布日期是 2023-02-20,原 v1 写 "2024-09" 错;同时
加 PNG decode-bomb guard(width × height + bitDepth + channels)作为硬约束,
Q8 / Open implementation decisions 段都补了。

**#10 缩 scope:** v2-F.0 的 `collectElements` 已经在 `server/src/ui/list_elements.ts`
公共,Phase 1 不再 refactor 它本身。real refactor seam 是 `dump → parse →
collect` orchestration(几行 handler 内代码)抽到共享函数。**严禁** capture
内部调注册的 `list_elements` tool handler。

**Acceptance scenario 增量:** S8(mapping 自包含验证)+ S9(decode-bomb guard)
+ S10(annotationId response-local 不假装跨调用 binding)。

**未变(codex round 1 ack):** Q2 handler-side reject、Q3 soft-degrade 方向(条件
是 schema 含 error 字段)、Q4 internal recipe、Q6 no collision avoidance(条件
是 mapping 在 output)、Q7 7-segment、Q8 pngjs(除日期错和 guard 漏)、Q9 placement、
Q10 solid badge、Q11 4px stroke、Q12 no collision v1。

### 2026-05-27 · Codex pre-impl grill round 2 — STOP fold-in

Reviewer: codex(msg id `2026-05-27T10-01-10.945Z_pid9351_db29d013`)。

Verdict: `STOP`,4 blocker(全是 round 1 fold-in 漏的 residual + 一处实施 contract
模糊),全部直接修订 v2 文本:

**#1(残留 `elementId` 引用)**:Round 1 改了 Q5 主决策,但 Q4 论证段(line 99)
和"与 v1 / v2-F.0 衔接"段(line 307-308)仍写"同 elementId / `tap_node(elementId)`"
反向引用。修订:line 99 改为"同 collect 顺序 → 同 `annotationId` 在同响应内
绑定同 center";衔接段重写,显式声明"整条链路不出现 elementId"。`elementId`
只在 Q5 rejected-design paragraph 和 Amendments 段出现(作为反例)。

**#2(`bounds` 字段命名错)**:Round 1 schema 写 `{l, t, r, b}` 短形式,但 v2-F.0
`Element.bounds` 是 `{left, top, right, bottom}`(`element-interaction.md:98`
+ `server/src/ui/list_elements.ts:30-35`)。修订:annotationElementSchema 用
`{left, top, right, bottom}` 长形式,与 v2-F.0 byte-equivalent。任何 painter
内部短名是 paint.ts local 实现细节,不进 output schema。

**#3(Element subset 没 lock,且引用了不存在的 `role`)**:Round 1 写"Phase 1
nails the exact field set;baseline 至少 text / resourceId / contentDesc /
**role** / clickable / windowIndex"。v2-F.0 `Element` 没有 `role` 字段,有
`class`(同源 inspector inspect 拿 `android.widget.Button` 这种值)。修订:
Phase 1 不再有 schema 自由度 —— annotationElementSchema 直接 spread v2-F.0
`Element` 全字段({resourceId, class, text, contentDesc, bounds, center,
clickable, windowIndex})+ 前置 `annotationId`,**byte-equivalent**。
注释明确"If v2-F.0 Element changes, this MUST follow in the same commit"。

**#4(helper signature 太瘦)**:Round 1 写 `collectCurrentElements(session)
→ Element[]`。codex 抓出 list_elements 公共输出还要 `windowCount`,helper
仅返 Element[] 会强迫 list_elements 再 parse 一次或埋 hidden side effect。
另:UI dump 落盘的 path 应该让 caller(handler)owning,以保证 captureId /
artifact / event semantics 全由 handler 主导。修订:helper signature 改为
`collectCurrentElements(session, uiDumpPath) → Promise<{elements, windowCount}>`,
caller-handler 责任分割明确写进 Open implementation decisions 段。
**新文档化**:`capture({annotateElements:true})` 即使 `kinds` 没要 `ui_dump`
也会内写 `<artifacts>/ui-<captureId>.xml`,events.jsonl 显式记 `annotated:true`
让 bundle / agent 不被无标 artifact 困惑。

**Round 2 verbatim suggestions 全采纳的旁支:**
- `screenshotPath:null ⇔ error:string` 不靠 docs,改 zod `.refine()` 强制(同时
  加 `error:string ⇒ elements.length===0 + elementCount===0`)
- MAX_PIXELS = `16_777_216`(精确 4096²),不写"~16M"模糊数;guard 必须读
  IHDR 前 25 字节 reject,不能等 `PNG.sync.read` 完成才检查 dim
- S10 改写,从 "annotationId 也相同" 改为"determinism 是 collection-order 副作用,
  **非契约一部分**,agent 不可跨调用 reuse"

**未变(codex round 2 ack):** Q5 annotationId / annotation.elements 方向(blocker
#1-#3 修复后)、Q9 placement、Q12 no collision v1、pngjs choice(date 修正后)。

### 2026-05-27 · Codex pre-impl grill round 3 — STOP fold-in

Reviewer: codex(msg id `2026-05-27T10-06-53.994Z_pid16400_2ac8e408`)。

Verdict: `STOP`,3 个 schema-consistency blocker(我 round 2 的 "byte-equivalent
spread" 声明与实际 schema 字段不符 + 残留 Phase-1-decides 段没删 + refine 漏一条
invariant)。全部直接修订 v3 文本:

**#1(annotationElementSchema 不是真 byte-equivalent)**:Round 2 声明"FULL Element
spread / no omission",但实际只列了 `{resourceId, class, text, contentDesc,
bounds, center, clickable, windowIndex}` 8 字段。v2-F.0 `Element`
(`server/src/ui/list_elements.ts:23-44`)还有 `package` / `hint` / `focusable`
/ `checkable` 4 个常驻字段 + `focused?:true` / `selected?:true` / `checked?:true`
3 个 true-only optional state。修订:annotationElementSchema 补全所有缺字段,
true-only 用 `z.literal(true).optional()`,schema comment 注明 v2-F.0 lock 的
"absent ≠ false" 语义(LLM 误读防护)。

**#2(残留 Phase-1-decides bullet 没删)**:Round 2 锁定了 annotationElementSchema,
但 Open implementation decisions 段最后一条 bullet "Phase 1 决定。MUST 覆盖
... SHOULD 覆盖 {text, resourceId, contentDesc, **role**, clickable, windowIndex}"
仍在 —— 这跟新 schema "no Phase 1 freedom" 直接矛盾,而且 role 字段已 round 2
确认不存在。修订:整条 bullet 删除。schema 一处声明权威,不留双写。

**#3(refine 漏 `elementCount === elements.length`)**:Round 2 加了 bi-directional
+ error⇒empty 两条 invariant,漏了 elementCount 与 elements.length 必须相等。
当前 schema 允许 success payload `{elementCount: 12, elements: []}` 这种 drift。
S1/S2 acceptance 又把 elementCount 当作"len(elements)"在断言。修订:`.refine()`
加第三条 `(d) a.elementCount === a.elements.length`,success/failure 两种 case
都覆盖。

**附:IHDR 字节数模糊**(non-blocking nit codex 也提了一句):round 2 写 25 B
不对。精确算:8B magic + 4B chunk length + 4B chunk type + 13B IHDR data
= **29 B**(不读 CRC);+4B CRC = 33 B。修订 Open implementation decisions
段标 29 B + const 名 `IHDR_HEADER_BYTES = 29`。

**未变(codex round 3 ack):** elementId grep clean(round 2 修复后); uiDumpPath
as helper input、`uiDumpPath` 顶层不被 annotate 副作用 overload、MAX_PIXELS =
4096²、Q5 / Q6 / Q9 / Q12 既有决策。

### 2026-05-27 · Codex pre-impl grill round 4 — STOP fold-in

Reviewer: codex(msg id `2026-05-27T10-10-19.573Z_pid21623_8fd30afa`)。

Verdict: `STOP` —— "narrow text fixes, not design objections"。2 处 doc
contradiction 与 round 3 实际 schema/常量不同步:

**#1**:annotationElementSchema 上方 comment 仍列旧 8 字段名,而 schema 真身
已 round 3 补全 11 常驻 + 3 true-only optional。修订:comment 不再 enumerate,
只 point 到 `server/src/ui/list_elements.ts:23-44` 作为权威源("Field list
intentionally NOT re-enumerated in this comment (would drift from source)"),
schema 自身字段是 single source of truth。

**#2**:`Open implementation decisions § PNG decode-bomb guard` 第一句仍写
"IHDR header(前 33 字节)",与下面的 `IHDR_HEADER_BYTES = 29`(29 B w/o CRC,
33 B w/ CRC)矛盾。修订:统一改为"前 29 字节,= IHDR_HEADER_BYTES;若同时校验
CRC,再读 4B = 33B"。

**Round 4 verified clean(codex direct answers):** annotationElementSchema
field-for-field 与 v2-F.0 Element 一致;`.refine()` 4 条 invariant 正确无矛盾
(`error ⇒ elementCount === 0` 与 `elementCount === elements.length` 在 error 路径
冗余但 harmless);Phase-1-decides bullet 已 round 3 删除确认;`role` / `elementId`
grep 在 round 2/3 既定的 historical/rejected-design 区域。

Round 5 待发(本 amendment fold-in 后)。
