# Android Debug MCP — v2-F Implementation Plan · Element-driven Interaction

Locked design: [`element-interaction.md`](./element-interaction.md)。本计划带 v2-F
从 v2-A(19 tool / `0.3.0`)到 [`element-interaction.md`](./element-interaction.md)
§ 验收 scenario 6 条全跑通(A 改写 + parser 字段覆盖 / B + center 取整 / C 多窗口
+ 非全屏 top root / D long_press happy / E 失败语义 / F 工具契约)。

**栈**:沿用 v1 / v2-A —— TypeScript + Bun ≥ 1.1、`@modelcontextprotocol/sdk` 1.x、
`zod` 3.x、`vitest` 1.x、`@biomejs/biome` 1.9.x。v2-F **不引入新 runtime
dependency**;`uiautomator dump` / `adb` 是外部 CLI,沿 v1 / v2-A chokepoint 模式。

**修订记录**:2026-05-25 lock + 实施计划落盘。codex 设计复审 2 轮(round 1
`patch-required` 3 blocking + 3 non-blocking,round 2 `patch-required` mechanical
doc-consistency)— 见 [`element-interaction.md`](./element-interaction.md)
§ 设计复审决策。2026-05-25 codex 计划评审 round 1 提 3 blocking + 1 non-blocking
+ #6 wording 修正,全部 fold-in 本文件;同步修了 lock Q8 内措辞 slip(`capturedAt`
→ `ts`,无设计翻案,仅一致性 fix)。

## 关键设计约束(实施时不得偏离)

- **不引入 selector 概念**(reject Route A)。`Element[]` 由 `list_elements` 一次
  返回,**agent 端做选择**;server 不解析 `{resourceId, text, contentDesc}` 组合、
  不实现 `matchIndex` 解决 cardinality、不返 `element_not_found` / `element_ambiguous`
  之类硬错码(design lock § 失败语义)。
- **每次 `list_elements` 必跑 fresh `uiautomator dump`**,不缓存;tool description
  显式声明 `"Do not cache this result"`(design lock Q4)。
- **v2-A `tap_node` 事件序列化的 `Node` shape 不动**:Phase 0 在 `UiNode` 上
  additive 扩字段供 `list_elements` 消费,但 `tap_node` 写事件时**继续不持久化**
  `text` / `content-desc` / `hint` / `checkable` / `checked` / `focused` /
  `selected`(v2-A § B Q4 / Q8 隐私轻量约束)。
- **v1 17 tool / v2-A 2 tool 全部不动**;v2-F 只新增 `list_elements` +
  `long_press` 两个 tool 和它们的事件类型;`events.jsonl` / `commands.jsonl`
  持久化格式 additive 扩(新增 `list_elements` / `long_press` event `type`)。
- **`windowIndex === 0` 不等于"唯一可达"**(design lock Q6);Phase 3 验收 scenario
  C 必须断言"非全屏 top root + 底层可穿透"行为。
- **`center` 必走 `Math.floor`**(design lock Element schema);奇数 bounds 不能
  返回 `.5` 坐标。
- 新硬错码(`ui_dump_failed` 复用 v2-A 已有)进 typed catalog;zod schema 校验失败
  不进 typed catalog(同 v1 现有 zod 拒绝路径)。

## Phase 编号

v2-A 是 Phase 0–5。v2-F 重新从 Phase 0 起编号;源文件落 `server/src/ui/`
(扩展 + 新增 `list_elements.ts`)与 `server/src/mcp/tools/`,与 v1 / v2-A 模块
互不冲突。

---

## Phase 0 — parser additive 扩展 ⚠️ 关键路径(隐私约束)

**目标**:纯模块。v2-A 隐私轻量的 `hierarchy.ts` parser 上**additive 加** 7 个可选
字段,为 `list_elements` 提供原料;同时**保证 `tap_node` 事件序列化 Node shape
不变**(privacy guarantee 不破)。

**Files**
- `server/src/ui/hierarchy.ts` — `UiNode` 加可选字段:
  ```ts
  text?: string | null,         // empty / undefined → null
  contentDesc?: string | null,
  hint?: string | null,
  checkable?: boolean,          // default false
  checked?: boolean,            // default false
  focused?: boolean,            // default false
  selected?: boolean,           // default false
  ```
  `parseUiHierarchy` 在 attribute 解析时填这些字段。文本字段 normalize:
  empty string 一律转 `null`。
- `server/src/mcp/tools/tap_node.ts` — **不动**(序列化 Node 时显式只取原 7 字段;
  若 toNodeForSerialization 之类 helper 不存在,Phase 0 内可加,不属翻案,只是
  enforce 隐私约束的 sealant)。
- `server/tests/ui/hierarchy.test.ts` — 新加 case 验证扩展字段:
  - **现有 fixture 已覆盖的状态**(用真实 fixture):
    - `text` —— `poppo-homepage.xml` / `poppo-overlay.xml` 的 TextView 节点,empty 转 null
    - `contentDesc` —— `login.xml` 等带 accessibility 标注节点
    - `checkable=true` —— `login.xml:6-8` 已有
    - `focused=true` —— `login.xml` / Poppo fixture 中状态节点
    - `selected=true` —— Poppo fixture 已包含
  - **现有 fixture 缺的状态**(`hint=` / `checked="true"` 在 `server/tests/fixtures/ui/` 中无样本):
    - **用 inline 合成 XML 在 test 内覆盖**(`<hierarchy><node ... hint="Search" /></hierarchy>`、
      `<hierarchy><node ... checkable="true" checked="true" /></hierarchy>`),
      不引入新 fixture 文件
    - 断言:`UiNode.hint === "Search"` / `UiNode.checked === true`
- `server/tests/mcp/tap_node.test.ts` — 新加 case 验证:即使 parser 抽了 text,
  `tap_node` 事件 / artifact 的 Node 序列化里**没有** `text` / `contentDesc` /
  `hint` 等字段。这是 Phase 0 的核心安全闸,**必须有这个测试**。
- `server/tests/ui/hit_test.test.ts` — sanity 一遍,确保现有 19 个 hit_test case
  仍 506/506。

**Delivers**:`UiNode` 扩展后的 `text` / `contentDesc` / `hint` / `checkable` /
`checked` / `focused` / `selected` 可消费;v2-A `tap_node` 隐私不变。

**Verify**:Vitest only。`bun run lint && typecheck && test` 全绿。

**风险**:中。
- **隐私 leakage**:若误把 `text` 灌进 `tap_node` 事件,违 v2-A Q4 / Q8。对策:
  专门写一条 vitest case grep `events.jsonl` 内不含运行时 `text`。
- **parser regression**:现有 19 个 hit_test case 在扩展后仍要全绿;不允许任何
  现有 case 因 `UiNode` shape 改动而失败(用 optional 字段保证向后兼容)。

依赖:无(纯模块)。**无 audit checkpoint**(scope 小 + 风险局部);Phase 0 的
finding 会在 Phase 1 audit 时一起 review。

---

## Phase 1 — `android_debug_list_elements` tool ⚠️ audit checkpoint

**目标**:把 Phase 0 的扩展 parser 接成 tool,实现 design lock § Q4–Q9。

**Files**
- `server/src/ui/list_elements.ts`(新模块)—— `collectElements(roots: UiNode[]):
  Element[]` 实现。
  - 反向 iterate `roots`(`for i = roots.length-1; i >= 0; i--`),
    `windowIndex = roots.length - 1 - i`,emit 顺序 = z-order 顶 first
  - DFS 后序(child 先 push,然后 self,前提是 `isUseful + hasPositiveBounds`)
  - `isUseful`:`text || contentDesc || hint || resourceId || checkable || clickable`
  - `hasPositiveBounds`:`bounds && bounds.right > bounds.left && bounds.bottom > bounds.top`
  - `toElement(node, windowIndex)`:构造 Element,`center.x = Math.floor((left + right) / 2)`、
    `center.y = Math.floor((top + bottom) / 2)`;`focused / selected / checked`
    optional 字段**只在 true 时输出**。
- `server/src/mcp/tools/list_elements.ts`(新模块)—— tool registration + handler:
  - input zod schema `{runId, label?}`
  - 描述前缀 = `"List interactive elements on the device screen. Do not cache this result; element coordinates change as the UI moves."`(grep 锚:`Do not cache`)
  - handler:抓 fresh `uiautomator dump` → `parseUiHierarchy` → `collectElements` →
    构造返回 `{ ts, captureId, elements, elementCount, windowCount }`
  - 同步产:`artifacts/ui-<captureId>.xml`、`{type:"capture", captureId, kinds:["ui_dump"]}`
    事件、`{type:"list_elements", captureId, elementCount, windowCount, label?}` 事件、
    `commands.jsonl` 一条
- `server/src/mcp/bootstrap.ts` — `registerAllTools` 注册 `list_elements`;
  `TOOL_COUNT` 19 → 20。
- `server/src/mcp/constants.ts` — `ANDROID_DEBUG_TOOL_NAMES` 加
  `android_debug_list_elements`。
- `server/src/summary/render.ts` — `get_run_summary` 渲染 `list_elements` 事件
  (timeline 可读)。
- `server/tests/ui/list_elements.test.ts` — `collectElements` 单测:
  - 用 `poppo-homepage.xml` 验证 happy path,断言 `windowCount=1`、`windowIndex=0`、
    parser 字段(**text / contentDesc / checkable / clickable**)各有 element 命中
    (`hint` 与 `checked` 在 Poppo fixture 中无样本,见下一条)
  - **inline 合成 XML 验证 `hint` / `checked` 透传到 `Element`**:`<hierarchy><node
    class="android.widget.EditText" package="p" bounds="[0,0][100,40]" hint="Search"
    .../></hierarchy>` 与 `<hierarchy><node ... checkable="true" checked="true"
    .../></hierarchy>` 各一,断言 `Element.hint === "Search"` /
    `Element.checked === true`(与 Phase 0 `hierarchy.test.ts` 用同 pattern)
  - 用 `poppo-overlay.xml` 验证非全屏 top root:`windowCount=1`、`windowIndex=0`,
    所有 bounds 都在 `[0,1399][1080,2320]` 内
  - 合成 multi-root fixture(`hit_test.test.ts` 已用的 multi-window inline XML)
    验证 z-order 倒序 + windowIndex 赋值(0 = 文档序最后)
  - filter rule:degenerate bounds 节点不入;无 text/id/clickable 节点不入
  - center 取整:奇数 bounds(`[10,10][101,101]`)→ `center = {x:55, y:55}`,非 55.5
- `server/tests/mcp/list_elements.test.ts` — tool 边界:
  - fake adb 走正常路径,断言返回 shape + 写入 `events.jsonl` 双事件
  - `uiautomator dump` 失败 → 硬错 `ui_dump_failed`
  - parser 失败 → 硬错 `ui_dump_failed`
  - 空屏 → 软返 `elements:[], elementCount:0`(不 error)
- `server/tests/integration/tool_contract.test.ts` /
  `server/tests/mcp/register.test.ts` — tool 数 19 → 20;
  `ANDROID_DEBUG_TOOL_NAMES` 长度 / 唯一性;`list_elements` 描述含 `"Do not cache"`
  字串(`expect(tool.description).toContain("Do not cache")`)。

**Delivers**:验收 scenario A(parser 字段覆盖)、B(filter rule + center 取整)、
C(multi-window + 非全屏 top root)的 list 侧。

**Verify(真机)**:`list_elements` 调一次,核对 Poppo 关注列表上 `text=""` 的行
不入 list 但 `clickable=true` 的 scrim 入 list;`bun run test` 全绿。

依赖 Phase 0。**audit checkpoint**(cadence A 第 1 次):本 phase 完成后过 codex。

---

## Phase 2 — `android_debug_long_press` tool

**目标**:补 v1 / v2-A 缺的长按交互,镜像 v1 `tap` 体例。**与 Phase 1 并行**。

**Files**
- `server/src/mcp/tools/long_press.ts`(新模块)—— tool registration + handler:
  - input zod schema `{runId, x: int, y: int, durationMs?: int.min(1).max(10000).default(500), label?}`
  - 描述:`"Long-press the screen at given coordinates. Equivalent to a swipe with no movement."`
  - handler:`adb shell input swipe <x> <y> <x> <y> <durationMs>`;写
    `{type:"long_press", x, y, durationMs, label?}` 事件 + `commands.jsonl`
  - 失败语义同 v1 `tap`(`device_disconnected` / adb 错)
- `server/src/mcp/bootstrap.ts` — 注册 `long_press`;`TOOL_COUNT` 20 → 21
  (假设 Phase 1 已先 land;若 Phase 1 / Phase 2 同 PR 落,则一次 19 → 21)。
- `server/src/mcp/constants.ts` — `ANDROID_DEBUG_TOOL_NAMES` 加
  `android_debug_long_press`。
- `server/src/summary/render.ts` — 渲染 `long_press` 事件(类似 `tap`)。
- `server/tests/mcp/long_press.test.ts` — fake adb 正常路径 + adb 错误硬错 +
  zod 范围拒(durationMs=0、durationMs=50000 各一条;断言返回 `isError:true` +
  不进 typed catalog,与 `interaction.test.ts:229-240` 同形)
- `server/tests/integration/tool_contract.test.ts` /
  `server/tests/mcp/register.test.ts` — tool 数 20 → 21(或 19 → 21);
  `Errors:` 描述含 `device_disconnected`(沿 v1 体例)。

**Delivers**:验收 scenario D 全段。

**Verify(真机)**:`long_press` 一个长按可触发的 view(头像 / 列表项)→ 设备出现
长按反馈(截图 / 肉眼证)。

**风险**:很低。镜像 v1 `tap` shape,新增字段只有 `durationMs`。

依赖:无(可与 Phase 1 并行,但 bootstrap `TOOL_COUNT` 同一 file 改动可能引 git
merge 冲突 —— PR sequencing 注意)。**无独立 audit checkpoint**(scope 小);
Phase 3 final audit 一起 review。

---

## Phase 3 — 验收 + fixture harvest + 回归 gate + 真机跑通

**目标**:design lock § 验收 6 条 scenario 定稿 + 真机跑通;fixture 收齐;回归。

**Files**
- `docs/v2/element-interaction.md` § 验收 —— 草案定稿(若实施中判据要调,走翻案
  规则,在 § 翻案规则段加 amendments)。
- `docs/v2/test-plan-v2f.md`(新)—— 对齐 [`test-plan-v2a.md`](./test-plan-v2a.md)
  体例:6 scenario manual checklist + evidence ledger(`runId` / `runDir` /
  device serial+API / Poppo package+version / Poppo repo SHA / MCP commit /
  `list_elements` / `long_press` tool 输出);prerequisites 段。
- `server/tests/fixtures/ui/` —— fixture 评估:
  - 现有 `poppo-homepage.xml` / `poppo-overlay.xml` / `poppo-follow-list.xml` /
    `login.xml` / `settings.xml` 5 份能否覆盖 Phase 1 全部 fixture-driven 测试?
  - **scenario C 多窗口 + 非全屏 top root** —— `poppo-overlay.xml` 是单 root
    形态(只 dump 了 dialog 自己);Phase 3 真机需 dump 一份**真正 multi-root
    带底层活动屏**的 fixture(候选:Poppo 内的 AlertDialog 形态 / PopupWindow,
    需 dump 真机现场)。两条分支:
    - 真机能复现 → 补 `poppo-multi-window.xml` + `list_elements.test.ts` 加真机
      multi-root case;test-plan-v2f 中 scenario C 标真机证据。
    - 真机不能复现 → **同时**两件事:
      (a) `test-plan-v2f.md` 中 scenario C evidence ledger 标 "multi-root 通过
          `list_elements.test.ts` 内 inline 合成 XML 覆盖,真机无观察"(类比 v2-A
          D-a / D-b 的 vitest fallback 形态);
      (b) **`element-interaction.md` § 翻案规则 段加 amendment**,记录 scenario C
          原决策("Poppo 分享 dialog 状态下 element 至少两个 windowIndex 且 dialog
          top root bounds 之外的主屏 element 仍在 list")改为"原决策保留,但真机
          v2-F.0 阶段未观察到 Poppo multi-window 形态;算法由合成 fixture 兜底,
          真机 multi-window 观察推后续 phase / 真出现场景"。**不允许只写
          test-plan 备注就当 scenario C 真机通过**(round 1 codex 明示)。
- `docs/README.md` —— 加 `test-plan-v2f.md` 索引(参 v2-A 当时格式)。
- 回归:`bun run lint && typecheck && test` 必绿。

**Verify(真机)**:6 条 scenario(A 关注列表 list / B filter + center / C 多窗口
+ 非全屏 / D long_press / E 失败 / F 工具契约)真机跑通;evidence ledger 6 份
落盘。device `951a20a2`,Poppo applicationId `com.baitu.poppo`,projectRoot 同
v2-A:`/Users/est9/AndroidStudioProjects/submodulepoppo`。

依赖 Phase 1 + Phase 2。**final audit**(cadence A 第 2 次也是终审):本 phase 后
codex 终审。

---

## 并行计划

两条 phase 独立可并行:

- **链 L(list_elements)**:Phase 0 → 1
- **链 P(long_press)**:Phase 2

Phase 2 不依赖 Phase 0(`long_press` 不消费 `UiNode` 扩展字段)。Phase 3 在两条
都完成后启动。本计划默认单人**串行**实施(0 → 1 → 2 → 3),并行只在双人 / 双
session 时启动。

## 关键路径风险

1. **Phase 0 隐私 leakage** —— `UiNode` 上加了 `text` / `contentDesc` 后,如何
   保证 `tap_node` 事件序列化时**不**带出去?对策:
   - 在 `tap_node.ts` 显式做 Node serialize helper,只取原 7 字段;
   - `tests/mcp/tap_node.test.ts` 加 case grep `events.jsonl` 内容不含运行时
     `text` / `content-desc` 字面。
   预算 ~25% 总工时。
2. **Phase 1 multi-window 反向 iterate 边角** —— `windowIndex = roots.length - 1 - i`
   计算和 z-order 顶 first 顺序的 invariant 容易写错(round 1 codex 就指出过原
   pseudocode 的错误)。对策:`list_elements.test.ts` 用 inline multi-root XML
   断言 z-order 顺序 + windowIndex 严格映射。
3. **Phase 3 multi-root 真机 fixture** —— Poppo 多数 dialog 走 BottomSheet
   挂在 ContentView 上(单 root,不 multi-window),真正的 multi-window 形态
   要找 AlertDialog / PopupWindow / system dialog。如真机难以复现该形态,scenario
   C **退化策略走 § Phase 3 的三件齐**(合成 fixture + test-plan-v2f evidence
   ledger 标记 + `element-interaction.md` § 翻案规则 加 amendment),不允许只写
   test-plan 备注就 sign-off。
4. **Phase 1 Element schema 命名飘** —— `Element` 与 v2-A `Node` 名字相似,
   reader 易混。对策:design lock § 与 v2-A / v1 衔接 段已说"故意不复用,两个
   shape 在不同 tool 上";实施时 `list_elements.ts` 显式 import `Element` type
   而非借 `Node`,避免 IDE 自动补全错引。

## codex audit 节奏(锁定:A)

A = **Phase 1 后 + 最终**,共 2 次。理由:
- Phase 0 是 v2-A 隐私轻量约束的 enforcement,scope 小,findings 在 Phase 1
  audit 时一起 review 即可
- Phase 1 checkpoint 锁 `list_elements` contract:`Element` schema 是否合理、
  filter / multi-window 行为是否符合 design lock § Q4–Q9、tool description
  prose 是否完整(含 `"Do not cache"`)
- Phase 2 是 v1 `tap` 的复制 + duration,scope 极小,不必独立 checkpoint
- 最终 audit 锁:6 条真机 scenario 是否跑通 + fixture 是否够 + 回归 gate 是否
  全绿 + tool inventory 是否 19 → 21 同步

v2-A 是 cadence A 3 次(Phase 1 + Phase 4 + Final);v2-F 是 cadence A 2 次
(Phase 1 + Final),原因是 v2-F 只有一条 chain,不像 v2-A 的 chain T + chain M
分立。

## Open implementation decisions(承接 design lock § Open)

design lock 列了 8 条;实施前需额外定:

1. **Phase 0 / `parseUiHierarchy` 扩字段策略** —— 在 attribute 解析阶段填,
   还是 lazy(`UiNode` getter)?**倾向**:eager(简单 + 与现有 7 字段同 path)。
2. **Phase 0 / `tap_node` Node 序列化 helper** —— 是否新增 `toSerializedNode`
   helper 显式 enforce 隐私轻量(只取原 7 字段),还是依赖 type system?
   **倾向**:新增 helper + 单测 grep `events.jsonl` 不含运行时文本。
3. **Phase 1 / `Element.package`** —— 同 v2-A `Node.package`,verbatim 取
   `node.package`?**倾向**:是。
4. **Phase 1 / `windowCount` 的 0-情况** —— `<hierarchy>` 空(`<hierarchy/>`),
   返回 `{windowCount: 0, elementCount: 0, elements: []}`?**倾向**:是,
   软返不报错。
5. **Phase 1 / `commands.jsonl` 写什么** —— `list_elements` 内部的 dump 路径走
   `captureUiDump`(`server/src/adb/capture.ts:52-95`),其中除 `uiautomator dump`
   外还可能跑 `/dev/tty` 探测 / file fallback / `cat` / cleanup,所以单写
   `command:"uiautomator dump"` 不是精确证据。**定形**:走 capture-mirror 形态
   `{tool:"list_elements", captureId, kinds:["ui_dump"], ts}`(`kinds` 字段同
   v1 capture 事件,`captureId` 关联 `artifacts/ui-<id>.xml`)。round 1 codex
   认账此形态。**不**写 adb 字面量,因为底层调用集合不稳定。
6. **Phase 2 / `long_press` 是否复用 v1 `tap` 的 redact 机制** —— v1 `tap`
   事件不带敏感字段;`long_press` 同形,**倾向**:复用 `Session.appendEvent` /
   `appendCommand` 内已有的 redact 路径(redaction 不在 `wrapToolHandler`,而是
   在 `server/src/session/session.ts` 的 append 接口里 —— round 1 codex 修正)。
7. **Phase 3 / `test-plan-v2f.md` 与 `test-plan-v2a.md` 是否合并** —— v2-A 时
   选择 standalone(open decision #5 已 sign-off)。v2-F 沿用 standalone。
8. **Phase 3 / fixture 真机 multi-root 是否硬性必需** —— 若 Poppo 难复现真正
   multi-window,scenario C 退化策略?**定形**(round 1 codex 校正,不允许只走
   manual note):**合成 fixture 兜底 + test-plan-v2f evidence ledger 标记 + `element-interaction.md`
   § 翻案规则 加 amendment** 三件齐;参见 § Phase 3 的对应 Scenario C 段说明。
   仅 manual note 不够 —— 必须有 lock-level amendment 记录"原决策保留 + 真机阶段
   未观察"。

## 关键文件清单(实施时优先 review)

- `server/src/ui/hierarchy.ts`(Phase 0 additive 扩字段)
- `server/src/ui/list_elements.ts`(Phase 1 新模块)
- `server/src/mcp/tools/list_elements.ts`(Phase 1 tool reg)
- `server/src/mcp/tools/long_press.ts`(Phase 2 tool reg)
- `server/src/mcp/bootstrap.ts`(`TOOL_COUNT` 19 → 21)
- `server/src/mcp/constants.ts`(`ANDROID_DEBUG_TOOL_NAMES` 加两条)
- `server/src/mcp/tools/tap_node.ts`(Phase 0 隐私 sealant —— 若新增 serialize
  helper)
- `server/src/summary/render.ts`(`list_elements` + `long_press` 事件渲染)
