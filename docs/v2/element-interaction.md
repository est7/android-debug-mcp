# Android Debug MCP — v2-F Design Lock · Element-driven Interaction

Locked: 2026-05-25.
Derived from a thread following v2-A 0.3.0 release;**直接采纳 mobile-next/mobile-mcp
的 "list + coord" 设计哲学**(Route B,对 Route A 的 selector-on-server 形态做反向
否决,见 § 设计复审决策)。codex 作为设计 reviewer 参与 2 轮(round 1 `patch-required`
3 blocking + 3 non-blocking,round 2 `patch-required` 仅 mechanical doc-consistency,
全部 fold-in 本文件)。Promoted from [`../backlog.md`](../backlog.md) § v2-F per
the docs promotion rule.

## 文档定位

v2-F = **element-driven interaction**:把 agent 的交互从"先眼瞄屏幕找坐标"升级到
"先列屏上所有可识别元素(带 `resource-id` / `text` / `content-desc` / `bounds`),
再按这些元素选择坐标 tap / swipe / long-press"。

v2-F.0 的 **server 端 surface** 只新增 2 个 tool:
- `android_debug_list_elements` —— 屏幕元素发现
- `android_debug_long_press` —— 长按交互(v1 / v2-A 缺这一项)

v1 的 `tap` / `swipe` / `input_text` / `send_key` 全部保留;v2-A 的 `tap_node` /
`map_ui_node_to_source` 全部保留。**不引入 selector 概念**(无 `tap_element` /
`swipe_element` / 服务器端 `{resourceId, text, contentDesc, matchIndex}` 解析)
—— element-driven 体现在 agent 端,agent 调 `list_elements` 看到完整列表,自己
按 `resource-id` / `text` 决策选哪个元素,再用其 `center` 坐标调老 tool。

本文件对齐 [`./source-mapping.md`](./source-mapping.md) 体例。v1 / v2-A 的决策与
持久化格式仍然有效且不动;本文件只锁 v2-F 在 v2-A 之上**新增**的部分。

## Baked-in assumptions(不上桌的前提)

1. **不在 server 端做 selector**(reject Route A)。元素选择逻辑全留给 agent;
   server 只保证"屏上元素的字面描述 + 物理位置"准确返回。理由见 § 设计复审决策。
2. **不缓存 `list_elements` 结果**。每次调用 = 一次新的 `uiautomator dump` +
   parse + flatten。原因:UI 随时变(动画 / 网络 / IME 弹起 / 滚动),缓存会让
   agent 拿陈旧坐标 tap 到错节点。tool description 显式声明 "Do not cache"
   (与 mobile-mcp 同条款)。
3. **不引入新 runtime dep**。`uiautomator dump` / `adb` / v2-A `hierarchy.ts`
   parser 基础设施(树解析 + dump artifact path)复用,v2-F.0 在 `UiNode` 上
   additive 扩可选字段(见 § Parser 前置);`rg` 不参与。
4. **Compose target 经 testTagsAsResourceId opt-in 复用**:popposhell 项目侧
   做 `Modifier.semantics { testTagsAsResourceId = true }` 一次性 opt-in 后,
   `Modifier.testTag(...)` 在 dump 里以 `resource-id` 暴露,自然进 `list_elements`
   的 `resourceId` 字段。v2-F 不需要新 Compose channel。
5. **Replay artifact 不是 v2-F.0 的目标**;v2-B(auto-replay)接管。v2-F 输出的
   坐标值会被 v2-B 转换成"重新 list_elements + 重新匹配"的形态;v2-F 自己只对
   "当下能否点对元素"负责。

## 实施分期

| Phase | 目标 | 前置 | 触发 |
|---|---|---|---|
| **Phase 1 — View-first** | Poppo / Vone。`list_elements` 返回 View 树解析后的元素列表;`long_press` 落地。**v2-F v1 即此阶段。** | v2-A 0.3.0(已 release) | 立即 |
| **Phase 2 — Compose-via-testTagsAsResourceId** | popposhell。Compose 端 opt-in 后 `list_elements` 输出自动包含 testTag → resourceId。 | popposhell root composable opt-in 落地 | Phase 1 跑出真实用量 + popposhell 团队接受 opt-in |
| **v2-F.1+ deferred** | `swipe_direction`(direction-based 便捷糖)/ `double_tap` / `drag(from→to)` / 不开 opt-in 的 Compose `semantics` channel / element 状态变化监听(等元素出现) | 真实用量信号 | 各自有具体场景才启动 |

## 决策表(Q1–Q12)

### A. 范围与架构选型

| # | 决策 | 选定 |
|---|---|---|
| Q1 | architecture route | **Route B(mobile-mcp 同款 list + coord)**;Route A(server-side selector)被否决 —— 见 § 设计复审决策 |
| Q2 | v2-F.0 新 tool 集 | **2 个**:`android_debug_list_elements` + `android_debug_long_press`;`tap` / `swipe` / `input_text` / `send_key` 沿用 v1;`tap_node` 沿用 v2-A |
| Q3 | 第一目标 app | View-first(Poppo / Vone);Compose 推 Phase 2 |

### B. `android_debug_list_elements`(新 tool,inventory 第 20)

| # | 决策 | 选定 |
|---|---|---|
| Q4 | 输入 schema + tool description | `{runId, label?}` —— 仅需 runId 定位 run;label 入 event(便于 timeline 阅读)。tool description 显式声明 **"Do not cache this result"**(同 mobile-mcp),提示 agent 每次交互前 fresh list |
| Q5 | filter rule | 节点入 list **必须满足**:(`text` 非空 OR `contentDesc` 非空 OR `hint` 非空 OR `resourceId` 非空 OR `checkable=true` OR `clickable=true`)**AND** `bounds.width > 0 AND bounds.height > 0`。等价于 mobile-mcp 的 `collectElements` 规则 + 增加 `clickable` 入选(我们的 Poppo 真机里 scrim 等 clickable 但无文本节点也得能 tap) |
| Q6 | multi-window 处理 | **扫所有 root**,每个 element 带 `windowIndex: number`(`0` = z-order 最顶,递增向下)。`windowIndex===0` 只表示"在顶层 root 里",**不等于"当前唯一可达"** —— 若顶层 root 是非全屏(Poppo 分享 dialog `[0,1399][1080,2320]` 这种),agent 在顶层 root bounds 之外 tap 仍会落到底层 root 的 element(同 v2-A `hit_test.ts` 的 fall-through 行为)。Agent 应组合 `windowIndex + bounds` 判断 reachability,**不能简单 `filter(e => e.windowIndex === 0)`** 丢掉低层。理由:list 是发现,不是命中 —— 给 agent 完整状态,自己做 reasoning |
| Q7 | framework id 处理 | **不过滤**;`android:id/*` 节点正常入 list(agent 选不选自决)。与 v2-A `tap_node` 的 anchor 排除规则**独立** —— anchor 排除是源码映射 phase 的语义,跟"屏上有什么 tappable"无关 |
| Q8 | result 形态 + 顺序 | 返回 `{ts, captureId, elements: Element[], elementCount, windowCount}`(`ts` 与 v1 `tap` / v2-A `tap_node` / v2-F `long_press` 对齐;**修正 r1 review 发现的 lock 内措辞 slip** —— 旧 Q8 写 `capturedAt`,但 § Tool I/O 写 `ts`,以 `ts` 为准,无设计层翻案);`elements` 按 **z-order 倒序**(顶层 window 在前 —— 文档序最后一个 root 先出,v2-A `hit_test` 已锁文档序最后 = z-order 最顶);同一 window 内 DFS 后序(子节点先于父节点) |
| Q9 | 持久化 | 写**双事件**:`{type:"list_elements", captureId, elementCount, label?}` + `{type:"capture", captureId, kinds:["ui_dump"]}`(后者复用 v1 capture 机制);artifact 落 `artifacts/ui-<captureId>.xml`;`commands.jsonl` 一条 |

### C. `android_debug_long_press`(新 tool,inventory 第 21)

| # | 决策 | 选定 |
|---|---|---|
| Q10 | I/O | input `{runId, x, y, durationMs?: number(1–10000, default 500), label?}`;output `{ts}`(同 v1 `tap`,纯 coord 工具不返 node) |
| Q11 | 实现 | 派 `adb shell input swipe <x> <y> <x> <y> <durationMs>`(同 mobile-mcp 实现)—— `input touchscreen swipe` 0 位移 + 长 duration = long press |
| Q12 | 事件 + 失败 | 写 `{type:"long_press", x, y, durationMs, label?}` 事件 + `commands.jsonl` 一条;失败语义同 v1 `tap`(device_disconnected / adb 错);input schema 由 MCP SDK zod 在 handler 前 reject,不走 typed catalog(见 § 失败语义) |

## Schema

### `Element` 对象(`list_elements` 返回 + `list_elements` 事件 element 字段不持久化,仅 tool 返回)

```jsonc
{
  resourceId: string | null,    // "com.baitu.poppo:id/login_button" / "android:id/content" / null
  class: string,                // 如 "android.widget.Button"
  package: string,              // 节点的 package(framework / app 区分用)
  text: string | null,          // node.text 字面;empty / undefined → null
  contentDesc: string | null,   // node.content-desc 字面;同上
  hint: string | null,          // node.hint(EditText 占位符);同上
  bounds: { left, top, right, bottom },  // 整数,同 v2-A Node
  center: { x, y },             // 整数;x = Math.floor((left + right) / 2)、
                                //       y = Math.floor((top + bottom) / 2)
                                // (奇数 bounds 时 floor 避免 .5;agent 直接拿去 tap)
  clickable: boolean,
  focusable: boolean,
  checkable: boolean,
  windowIndex: number           // 0 = 顶层 root,见 Q6
  // 以下仅当 true 时出现,避免 LLM 误判 false 状态
  focused?: true,
  selected?: true,
  checked?: true                // 当 node.checkable=true 且 node.checked=true
}
```

`center` 是 server 端计算的便利字段;`bounds` 仍保留供 agent 做"是否覆盖某区域"
判断。无 `text` 字段的 `text:""` 一律 normalize 为 `null`(与 v2-A `Node.resourceId`
同 convention)。

### `list_elements` 事件(`events.jsonl`)

```jsonc
{
  ts,                          // append 层补
  type: "list_elements",
  captureId,                   // 对应 artifacts/ui-<captureId>.xml + 同时写入的 capture 事件
  elementCount: number,        // 本次扫出的 element 数(全 window)
  windowCount: number,         // root 数
  label?
}
```

**element 列表本身只在 tool response 里返回,不持久化进 `events.jsonl`** —— XML
artifact 已经存了完整原始 dump,events 不重复存解析结果,与 v2-A `tap_node` 事件
体例一致(后者只存 `tappedNode` / `anchorNode` / `ancestorChain` 关键节点,不存
完整树)。

### `long_press` 事件(`events.jsonl`)

```jsonc
{
  ts,
  type: "long_press",
  x, y,
  durationMs,
  label?
}
```

与 v1 `tap` 事件同形,加 `durationMs`。

### Tool I/O

`android_debug_list_elements`:
- **input**:`{ runId, label? }`
- **output**:`{ ts, captureId, elements: Element[], elementCount, windowCount }`

`android_debug_long_press`:
- **input**:`{ runId, x: int, y: int, durationMs?: int(1–10000, default 500), label? }`
- **output**:`{ ts }`(同 v1 tap)

## element 收集 recipe(Q5)

**Parser 前置:** v2-A 的 `server/src/ui/hierarchy.ts` 出于隐私考量**故意不抽**
`text` / `content-desc` / `hint` / `checkable` / `checked` / `focused` /
`selected`(见 v2-A § B Q4 / Q8 "events.jsonl 隐私轻量")。当前 `UiNode` shape
只有 `resourceId / class / package / bounds / index / clickable / focusable /
children` 7 字段。

v2-F.0 需要补 `Element` 缺的字段,**Phase 0 必先扩 parser** —— 在 `UiNode` 上
**additive** 加 `text? / contentDesc? / hint? / checkable? / checked? / focused?
/ selected?` 可选字段(default `null` / `false`,不破 v2-A 现有 7 字段语义)。
**v2-A `tap_node` 事件序列化的 `Node` shape 保持不变**(继续不持久化运行时 text /
content-desc —— 隐私轻量约束保留);只是内存里 parser 产物多了几个可选字段,由
`list_elements` 消费、由 `tap_node` 写事件时忽略。属 additive 扩展、不算 v2-A 翻案。

实现位置:`server/src/ui/list_elements.ts`(新模块),消费扩展后的 `UiNode[]`。

```
function collectElements(roots: UiNode[]): Element[] {
  const elements: Element[] = [];
  // Iterate roots in REVERSE document order so z-order topmost emits first.
  // windowIndex = 0 always = z-order topmost root (= last doc-order root).
  for (let i = roots.length - 1; i >= 0; i--) {
    const windowIndex = roots.length - 1 - i;
    descend(roots[i], windowIndex, elements);
  }
  return elements;
}

function descend(node: UiNode, windowIndex: number, out: Element[]): void {
  // post-order: descend first, then consider this node
  for (const child of node.children) descend(child, windowIndex, out);

  if (!isUseful(node)) return;
  if (!hasPositiveBounds(node)) return;
  out.push(toElement(node, windowIndex));
}

function isUseful(node: UiNode): boolean {
  return Boolean(
    node.text || node.contentDesc || node.hint ||
    node.resourceId || node.checkable || node.clickable
  );
}
```

约束:
- v2-A `hit_test.ts` 已锁:`<hierarchy>` 文档序最后一个 root = z-order 最顶。
  list 反向 iterate 后:**emit 顺序 = z-order topmost first**;`windowIndex = 0`
  指向同一个 root。两端语义一致,无歧义。
- DFS **后序**(child 先于 parent):上层容器最后入 list,跟 mobile-mcp 一致;agent
  自顶向下读列表时会先看到叶子。

## 失败语义

判别原则同 v1 / v2-A:能给出可信答案 → 软结果;不能跑成 → 硬错。

| 失败模式 | 归类 | 返回 |
|---|---|---|
| 无 active session / runId 无效 / 设备掉线 | 硬错 | `{isError, code}`(同 v1) |
| `uiautomator dump` 失败 | 硬错 | `{isError, code:"ui_dump_failed"}`(复用 v2-A 已加错误码) |
| dump 成功但 parse 失败 | 硬错 | `{isError, code:"ui_dump_failed"}`(同上;parser 错也归这里) |
| dump 成功且 parse 成功,但**零 element**(屏空 / 全过滤掉)| 软结果 | `{elements:[], elementCount:0, ...}`(空数组,不是错) |
| `long_press` 派发到 `(x, y)` 失败(adb error) | 硬错 | `{isError, code}`(沿用 v1 tap 一套) |
| `long_press` `durationMs` 越界 / 缺 runId / 其他 schema 无效 | SDK 输入验证 isError | MCP SDK 的 zod schema 在 handler 之前 reject;返回 `{isError:true, content:[{type:"text", text:"<zod error>"}]}`,**不进 typed catalog**(同 v1 现有 zod 拒绝路径,见 `server/tests/mcp/interaction.test.ts:229-240`) |

**不引入 element_not_found / element_ambiguous / selector_invalid** —— 这些是
Route A 的概念,Route B 下 element 选择由 agent 做,server 不二判。

## 与 v2-A / v1 衔接

- v1 `tap` `swipe` `input_text` `send_key` —— 不动。Agent 从 `list_elements` 拿到
  `center` 后直接调 v1 `tap { runId, x: center.x, y: center.y, label? }`。
- v2-A `tap_node` —— 仍是源码映射链 T 的入口(它返回 `anchorNode` / `ancestorChain`,
  喂 `map_ui_node_to_source`)。`list_elements` 与 `tap_node` 互补:**发现**用前者,
  **tap + 富回执 + 进 map**用后者。
- v2-A `Node` shape 与本文件 `Element` shape **故意不复用**:`Element` 是 list
  视角(flat,带 `center` / `windowIndex`);`Node` 是节点身份视角(树关系 / index /
  无 center)。两个 shape 在不同 tool 上,reader 不混。

## 与 mobile-mcp 的偏离(刻意保留差异)

| 项 | mobile-mcp | v2-F | 理由 |
|---|---|---|---|
| 输入参数 | 全部 tool 带 `device: string` | 全部 tool 带 `runId: string` | v2-F 复用 v1 session 模型,设备由 session 绑定 |
| Element.identifier | 单一 `identifier` 字段(等于 `resource-id`) | `resourceId` 全字段 | 命名与 v2-A `Node.resourceId` 对齐 |
| Element.label | `content-desc \|\| hint` 合并字段 | 拆 `contentDesc` / `hint` 两个独立字段,均可为 null | i18n 信号源不同(contentDesc 是无障碍标注,hint 是输入提示),合并丢信息 |
| filter clickable | 不入 `isUseful` 条件 | 入 `isUseful` 条件 | scrim / 透明 overlay clickable 但无 text/id,Poppo 真机里命中 v2-A scenario E 的 `recycled_row_id` 时仍需要进 list 让 agent 看见 |
| multi-window | collectElements 等价扁平,无 windowIndex 标记 | element 带 `windowIndex` | 让 agent 显式区分顶层 vs 底层,避免误点穿透 |
| element 持久化 | 不持久化(纯 tool 返回) | 不持久化 + 同时写 capture 事件 + ui_dump artifact | 与 v2-A `tap_node` 双事件体例对齐,审计可追溯 |
| 失败模型 | actionable error 一律 string message | 硬错 + typed code(`ui_dump_failed` 等) | 与 v1 / v2-A error catalog 体例对齐 |
| double_tap / drag-from-to / direction-swipe | 各自 tool | **不做**(推 v2-F.1) | KISS,先看真实用量 |

## 验收 scenario(定稿 2026-05-25)



实施期(Phase 0–2)未触发翻案,6 条 scenario 保持锁定形态。Phase 3 manual
checklist + evidence ledger 见 [`./test-plan-v2f.md`](./test-plan-v2f.md);
该 plan 是 *如何* 在真机上证明每条 scenario,本表是 *什么* 必须被证明。


| 编号 | 场景 | 通过判据 |
|---|---|---|
| A | `list_elements` 全 happy path + parser 字段覆盖 | 在 Poppo 关注列表调 `list_elements` → 返回 `elements[]`(全 window),含 `resource-id` 为 `com.baitu.poppo:id/avatar` 的多个条目;**至少能观察到** `text` / `contentDesc` / `hint` / `checkable` / `clickable` 各字段在不同 element 上正确填充(证明 parser 扩展生效);artifact `ui-<id>.xml` + `list_elements` 事件 + `capture` 事件三件齐 |
| B | filter rule + center 取整 | 同 dump 输入,`isUseful` 过滤后无文本无 id 无 clickable 的 LinearLayout 包装节点不在 list;degenerate-bounds 节点(`[0,0][0,0]`)不在 list;**奇数 bounds**(例如 `[10,10][101,101]`)的 element 取 `center = { x: 55, y: 55 }`(`Math.floor`)而非 `55.5` |
| C | multi-window + 非全屏 top root 可达性 | 在 Poppo 分享 dialog(顶层 root bounds `[0,1399][1080,2320]` 非全屏)状态下调 `list_elements` → element 至少**两个 windowIndex**(`0` = dialog 内、`>=1` = 底层主屏);dialog top root bounds **之外**的 element(如主屏顶部 backButton)仍出现在 list 且 windowIndex>=1 + bounds 完整 —— 证明 agent 能依据 `windowIndex + bounds` 判断穿透可达性,不能简单 `filter(windowIndex===0)`;非 dialog 状态(单 root)所有 element 都是 `windowIndex===0` |
| D | `long_press` happy path | `long_press { runId, x, y, durationMs: 1200 }` → 设备触发长按(肉眼/截图证),`long_press` 事件 + `commands.jsonl` 写入,无副作用 tap 事件 |
| E | 失败语义 | dump 失败 → `ui_dump_failed`;`long_press { durationMs: 0 }` → SDK zod 拒(isError + 文本错误信息,不进 typed catalog);`long_press { durationMs: 50000 }` → 同;空屏 → 软返 `elements:[]` 不报错 |
| F | 工具契约 + tool description | `TOOL_COUNT` bootstrap.ts 19→21 同步;`ANDROID_DEBUG_TOOL_NAMES` 加 `android_debug_list_elements` + `android_debug_long_press`;`Errors:` 描述列全所有硬错码(`ui_dump_failed` 等);**`list_elements` tool description 显式含 "Do not cache this result"** 字串(契约测试 grep 之) |

## Open implementation decisions(实施时定形)

1. `Element.class` 字段是直接 verbatim node.class(e.g., `androidx.recyclerview.widget.RecyclerView`)还是 normalize 成 simple name(`RecyclerView`)?**倾向**:verbatim,与 v2-A `Node.class` 对齐
2. `Element` 是否带 `id: number`(在 list 中的序号)以让 agent 在响应里引用 element 时不必复写整个对象?**倾向**:不带,LLM 自带 index reasoning;加了反而引导"用序号 replay"陷阱(下次 list 顺序可能变)
3. `windowIndex` 命名 vs `windowDepth` vs `zOrder`:**倾向** `windowIndex`(mobile-mcp 没这字段,我们自创;名字最直观)
4. `list_elements` 是否接受 `clickableOnly?: boolean` 入参?**倾向**:不加;agent client-side filter 已足够,加这个 param 容易诱导 agent 漏掉 scrim
5. `long_press` 是否走 `wrapToolHandler` 同样路径?**倾向**:是,error shape 完全同 v1 tap
6. `tap_node` 是否同步加 `windowIndex` 字段到 `Node`?**倾向**:不加(v2-A locked,不就地改);若真需要,走 v2-A amendments 段
7. tool inventory 19 → 21 同步契约测试 + bootstrap.ts TOOL_COUNT(同 v2-A Phase 1/4 体例)
8. 验收 scenario 5 条 → 实施 Phase 末定稿

## 显式 out-of-scope(v2-F.0 不做)

- **任何 selector 概念**(`tap_element` / `swipe_element` / `long_press_element`)—— Route A 被否,见 § 设计复审决策
- `double_tap` / `drag` (from→to two-coord) / `direction-based swipe` —— v2-F.1 增量
- element 状态变化监听 / `waitForElement` / stabilization —— let agent retry,与 v2-A `let it crash` 同
- 服务器端 i18n 翻译 / locale 反查 —— 同 v2-A
- mobile-mcp 集成或子进程包装 —— 自家 stack 内全做(v2-A `hierarchy.ts` parser 基础设施复用,v2-F.0 additive 扩字段即可,见 § Parser 前置)
- `list_elements` 缓存 / TTL —— 显式声明 "Do not cache" 同 mobile-mcp

## 设计复审决策(provenance,留痕)

**Route A vs Route B 选型过程**:

- 初始设计(本文件被覆盖前的 `element-tap.md` 草稿)沿 Espresso / Selenium 思路
  走 Route A:server 端 selector schema `{resourceId, text, contentDesc, matchIndex}` +
  AND 复合 + `element_not_found` / `element_ambiguous` 硬错。
- 在抓取 [`mobile-next/mobile-mcp`](https://github.com/mobile-next/mobile-mcp)
  `src/server.ts` + `src/android.ts` 后发现:他们刻意走 Route B —— `list_elements`
  返回全屏 element 列表,coord-based tap/long_press/swipe 处理交互。
- Route B 在我们 stack 上有 3 个具体优势:
  1. server 代码量小一个数量级(无 selector schema / 无 AND 解析 / 无 cardinality
     处理 / 无 framework id 边界);
  2. v2-A `hierarchy.ts` parser 基础设施(树解析 + dump artifact path)复用,v2-F.0
     在 `UiNode` 上 additive 扩 7 个可选字段(text/contentDesc/hint/checkable/
     checked/focused/selected,见 § Parser 前置),新代码 = parser additive 扩展 +
     `list_elements.ts` view layer + 2 个 tool registration;
  3. element 选择 reasoning 留在 agent 端,跟 LLM 工作模式更贴。
- Route A 唯一明显胜出的项是"replay artifact stability"(selector 比坐标稳),
  但这是 v2-B 的责任,v2-F 不必承诺。

**结论**:Route B(本 lock 形态)。

**codex 设计复审 round 1**(thread `review/v2f-design`,2026-05-25):verdict
`patch-required`,Route B 方向获认,但提 6 项 patch(3 blocking + 3 non-blocking)
已全部 fold-in 本 lock,见以下:

- **Blocking 1 / window 顺序契约自相矛盾** —— 原 Q8 写 "z-order 最顶在前" 但 recipe
  正向 iterate `roots.forEach`,实际 emit bottom-first。Q8 现明确 z-order 倒序,
  recipe pseudocode 改为反向 iterate + `windowIndex = roots.length - 1 - i`。
- **Blocking 2 / `windowIndex===0` 过度声明为 "current reachable"** —— v2-A
  `hit_test` 是 coord-based fall-through(顶层非全屏时点击 outside 落底层)。Q6
  现声明 `windowIndex===0` 只是"在顶层 root";低层 element 在顶层 bounds 之外仍可
  达;agent 应组合 `windowIndex + bounds`。Scenario C 加入"非全屏 top root 穿透"
  断言。
- **Blocking 3 / parser 复用声明遮蔽真实成本** —— v2-A `hierarchy.ts` 隐私轻量
  故意不抽 text/contentDesc/hint/checkable/checked/focused/selected。新加 § Parser
  前置 段:Phase 0 必须 additive 扩 `UiNode`(可选字段,default null/false);v2-A
  `tap_node` 事件 Node 序列化保持不变。属 additive,非 v2-A 翻案。
- **Non-blocking 4 / `checkable` 无 `checked`** —— Element schema 加 `checked?: true`
  (与 `focused?` / `selected?` 同 convention)。
- **Non-blocking 5 / `center` 奇数 bounds 出 .5** —— schema 明确 `Math.floor((left
  + right) / 2)` / `Math.floor((top + bottom) / 2)`。
- **Non-blocking 6 / zod 错误形态误标** —— 原失败表写 `{isError, code:"validation"}`
  ,但 v1 / v2-A typed catalog 无 `validation` 码,zod 在 handler 之前 reject
  形态不同。失败表更正为 "SDK 输入验证 isError,不进 typed catalog,同 v1 现有
  zod 拒绝路径"。

并答复 codex 关于 8 条 open implementation decisions 的具体反馈:#2(不加
`Element.id`)、#3(`windowIndex` 名字)、#6(不回填 `windowIndex` 到 v2-A `Node`)
显式同意;其他条 implicit。

**codex 设计复审 round 2**(thread `review/v2f-design`,2026-05-25):verdict
`patch-required` 但 codex 明示"only mechanical doc-consistency cleanup; no
remaining design objection to Route B or the six round-1 fixes",2 项:

- **lock 状态行还写 DRAFT** —— 顶部 "Locked: *DRAFT*..." 已改为 "Locked: 2026-05-25"
  + 摘录 2 轮复审历史。
- **3 处 "parser 已现成 / 直接复用" 措辞与 § Parser 前置 自相矛盾** —— Baked-in
  assumption #3、out-of-scope mobile-mcp 行、§ 设计复审决策 Route B 优势 #2 三处
  全部改为 "parser 基础设施复用 + v2-F.0 additive 扩字段",指向 § Parser 前置。

这两项 fold-in 本 commit。round 2 即 design lock 正式 sign-off,无需 round 3。

## 翻案规则

同 v1 / v2-A:本文件 lock 后不就地改。v2-F 实施中若某决策需翻案,新增 amendments 段
记录原决策、新决策、触发原因、影响范围,并同步 [`../README.md`](../README.md) 索引。

## Amendments

### 2026-05-25 · Scenario C real-multi-window 真机未观察(算法保留,合成兜底)

**原决策**(§ Q6 + § 验收 C):`list_elements` 对 `<hierarchy>` 多 root 反向 iterate,
`windowIndex=0` 锁 z-order 最顶;Scenario C 在 Poppo 分享 dialog / AlertDialog /
PopupWindow / 系统 dialog 状态下,**真机** 必须观察到 ≥2 `windowIndex`,且顶层 root
bounds 之外的主屏 element 在 list 内、`windowIndex >= 1` + bounds 完整 —— 证明
非全屏 top root 可穿透。

**新决策**(amendment,非翻案):算法 + 合成 fixture 覆盖保留不变,**真机
multi-window 观察推后续 phase / 真出现场景**。Scenario C 在 v2-F.0 阶段以三件齐
退化形式收尾,manual checklist 中 Branch 退化 已 marked。

**触发原因**(2026-05-25 真机 acceptance 期):

- 在 POCO F3 + MIUI 13 上触发 MIUI **system permission dialog**
  (`com.lbe.security.miui` "是否允许"Poppo"使用麦克风进行录音"),uiautomator
  dump 返回 `<hierarchy>` direct `<node>` 子节点数 = 1,且 dump 内全部节点
  `package=com.lbe.security.miui` —— Poppo (`com.baitu.poppo`) 完全不在 dump 内。
  系统 dialog 在独立进程,uiautomator 在该设备 / 该 ROM 上对 foreground accessibility
  window 的 traversal 只返回当前激活窗口。
- 同一 device 上 Poppo 内 BottomSheet 形态 *设计上* 即单 root(BottomSheet 挂在
  host Activity 的 ContentView 上,非独立 root),lock § Phase 3 风险 #3 已预言。
- AlertDialog / PopupWindow 也是 Poppo 同进程 Activity 上 Dialog window,uiautomator
  实测同样单 root(同进程 dialog 通常通过 Dialog window token 挂上层,但 dump
  walker 拿到的是 active window tree)。

**算法正确性 evidence**(不依赖真机):
- `server/tests/ui/list_elements.test.ts:74` *"emits windowIndex=0 for the
  document-order LAST root"* —— inline 合成 two-root XML,断言反向 iterate
  + `windowIndex = roots.length - 1 - i` 公式。
- `server/tests/ui/list_elements.test.ts:91` *"walks each window's tree in DFS
  post-order"* —— inline 合成 XML 锁同窗口内的遍历顺序。
- `server/src/ui/list_elements.ts:42-50` `collectElements` 实现与 lock §
  Q6 / § element 收集 recipe 字面一致。

**影响范围**:

- v2-F.0 acceptance Scenario C 在 manual checklist 内以 退化 三件齐 收尾,
  evidence ledger 见 [`./test-plan-v2f.md`](./test-plan-v2f.md) § Scenario C。
- 不需要新增 `poppo-multi-window.xml` 真机 fixture。算法层契约由合成 fixture
  + 上述两条 vitest case 钉死。
- 若后续真机出现 ≥2 root 的 dump(其他 ROM / 其他 dialog 形态 / 其他 app),
  补 fixture + `list_elements.test.ts` 真机 case;届时无需修订本 lock 或本
  amendment —— 本 amendment 只声明 v2-F.0 阶段未观察,不否决未来的观察。
- 不算 design 翻案 —— 锁 Q6 行为不变,锁 § 验收 C 判据不变;只是真机阶段
  退化为 算法 + 合成 + ledger 三件齐 形态。

### 2026-05-25 · Q12 / § 失败语义 zod-rejection wire shape clarification

**原描述**(Q12 + § 失败语义 表 row 4 + § 设计复审决策 round 1 Non-blocking 6):
描述 zod 输入校验失败时,MCP SDK 返回 `{isError:true, content:[{type:"text",
text:"<zod error>"}]}`,引述 `server/tests/mcp/interaction.test.ts:229-240` 作为
依据。

**真机观察**(2026-05-25 Phase 3 acceptance Scenario E-b):

- 通过 vitest `InMemoryTransport` 的 unit test 套调 `client.callTool` —— 服务器
  zod 拒绝后,SDK client 端 **的确** 返回 `{isError:true, content:[text]}` tool result
  envelope。
- 通过 Claude Code 的真机 stdio MCP client 直连 server,同一拒绝在 wire 上以
  JSON-RPC **`-32602 INVALID_PARAMS`** 错误响应返回 —— client SDK 把它当 RPC error
  throw / 上抛,而非 `{isError:true}` tool result。

**结论**(documentation correctness,非 design 翻案):上述两种 wire shape **都
spec-compliant**:JSON-RPC error response 是 MCP / JSON-RPC 规范的标准形态,
`{isError:true}` 是 InMemoryTransport-backed SDK client 的 recovery 形态。
Q12 / § 失败语义 写的 `{isError:true}` 形态实际上是 *InMemoryTransport
特定* 的,生产 stdio transport 会暴露 `-32602` 形态。

**真正的契约**(下面 4 条在两种 wire shape 上都成立,Phase 3 真机已 verify):

1. 拒绝发生在 handler 运行之前;
2. 没有副作用(events.jsonl / commands.jsonl 不增,无 adb 调用);
3. zod 字面 message 原文回到 client;
4. **不进** typed error catalog(没有 `error: "..."` JSON 域错码)。

**影响范围**:

- Q12 + § 失败语义 表 row 4 + § 设计复审决策 round 1 Non-blocking 6 的措辞继续
  保留(不就地改),本 amendment 加 transport 维度澄清。
- 现有 vitest case(`long_press.test.ts:154/167` + `interaction.test.ts:229-240`)
  断言形态保持不变(它们走 InMemoryTransport 是对的);不补充 stdio-shape
  case —— 真机 stdio 的 `-32602` 行为是 SDK 给的,不是我们 server 代码控制
  的,断言它等于把 SDK 的实现细节锁死。
- 文档 / agent-side onboarding 应在 README / agent 提示里把 "zod 拒绝两种
  wire shape" 写清楚 —— 推后 README 维护周期处理,本 amendment 不补 README。
- 不算 design 翻案 —— 锁 Q12 行为(rejection-before-handler / 不进 typed
  catalog)不变;只是真机阶段补足 transport 维度的 wire shape 描述。

### 2026-05-25 · Scenario A `hint` 真机 Poppo 结构性不可达(算法保留,vitest 兜底)

**原决策**(§ 验收 A):`list_elements` 真机 acceptance 必须观察到 `text` /
`contentDesc` / `hint` / `checkable` / `clickable` 各字段在不同 element 上正确
填充,证明 v2-F.0 Phase 0 parser additive 扩字段在线生效。

**新决策**(amendment,非翻案):

- `text` / `contentDesc` / `clickable` / `selected` —— 真机已在 关注列表 (原始
  Scenario A run) 命中。
- `checkable` + `checked` —— 真机已在 DynamicAddActivity 弹出的
  `dialog_visibility_permission.xml` RadioButton 上命中(rerun 2026-05-25
  runId `2026-05-25T08-28-25.204Z_huXV` captureId `d8b1829add06`)。
- **`hint`** —— 在 Poppo 应用范围内**结构性不可达**;算法保留 + vitest 兜底,
  acceptance Scenario A 该字段以本 amendment 形态收尾。

**触发原因**(2026-05-25 Phase 3 cadence-A 第 2 次 audit 期):

- codex 锁 1 个 blocking finding:Scenario A 验收 hint / checkable 真机未覆盖,
  跟 Scenario C 同种 "locked criterion 真机降级" 形态,要么补真机,要么 amendment
  形式。
- `checkable` 已通过 rerun 补真机覆盖(visibility dialog RadioButton);**`hint`
  rerun 真机仍然 null**,经分析根因如下:
  - Poppo / Vone 全 codebase 走 *code-driven i18n*(workspace
    `CLAUDE.md` 的 cross-repo common ground 第 1 条:**"i18n is code-driven,
    never `android:text`"**)。translated string 来自
    `TranslateResource.getStringResources(key)`,在 runtime 由 translation
    binding 拦截并通过 `setText()`(而非 `setHint()`)注入到 View。
  - 真机 DynamicAddActivity 上 `com.baitu.poppo:id/content` EditText 验证此假设:
    layout XML 写明 `android:hint="@string/hint_think_sth"`,但 uiautomator
    dump 给的是 `text:"说点什么记录这一刻…"` + `hint:null` —— 占位符路由到 text
    字段。
  - 结论:在 Poppo / Vone 任意可达屏,`UiNode.hint` 均结构性为 `null`,
    `list_elements` 返回的 `Element.hint` 自然也是 `null`。这是 Poppo *app 端*
    的 UI design choice 决定的,不是 v2-F 算法在解析端的缺陷。

**算法正确性 evidence**(不依赖真机):

- `server/tests/ui/hierarchy.test.ts` 现有 case *"extracts hint from inline XML
  and treats absence as null"* —— inline 合成 EditText XML 带 `hint="Search"`,
  断言 `UiNode.hint === "Search"`。
- `server/tests/ui/list_elements.test.ts:45` *"propagates `hint` from a parsed
  EditText through to the Element"* —— inline 合成 XML 验证 hint 从 parser 透到
  Element。
- 这两条断言任意 ROM / 任意 app 上只要 uiautomator dump emit `hint="..."`,
  `list_elements` 就会 surface;Poppo 是因为 *app 端的 setHint() 没被调* 才让
  hint 在 uiautomator dump 中为空 —— 把 v2-F 移植到任一 non-code-driven-i18n 的
  app 上,这条断言会自然兑现。

**影响范围**:

- v2-F.0 acceptance Scenario A `hint` 字段在 Poppo 真机以本 amendment 形态收尾,
  跟 Scenario C 三件齐 类似但性质更弱 —— **不需要** "三件齐",因为:
  - (a) ledger 见 [`./test-plan-v2f.md`](./test-plan-v2f.md) § Scenario A 已记;
  - (b) vitest inline-XML hint case 已存在;
  - (c) 不需要 lock 形态 amendment 中 "原决策保留" 那种 "推后续 phase 真出现场景"
        语句 —— hint 算法 *已经* 在两条 inline XML 测试上覆盖,Poppo 上的不可达
        是 *app 端* 的设计选择,与 v2-F 在 *任意非 Poppo app* 上的行为正交;
        本 amendment 就是 (c)。
- 不算 design 翻案 —— 锁 Q5 / § Element schema 关于 hint 的提取契约不变,锁
  § 验收 A 关于 hint 的判据本质不变;只是真机阶段在 Poppo 这一 app 上由 app 端的
  UI design choice 决定它不出现,acceptance ledger 标记并指向 vitest + 本
  amendment。
- 类比 v2-A 时 Scenario B (no-anchor):Poppo 容器结构让真机不可能产生
  `anchorSource:"none"`,acceptance 也是 ledger + vitest 兜底 + 拆 B-1/B-2/B-3
  子检查(详见 [`./test-plan-v2a.md`](./test-plan-v2a.md) § Scenario B)—— 本
  amendment 沿用同样体例,只是把 sub-check 拆解写在本 lock § Amendments 而非
  test-plan。
- 未来若 v2-F 接入非 code-driven-i18n 的 app(如 popposhell Compose flavor 或
  外部 partner app),hint 真机 surface 会自然命中,不需要修订本 amendment 或本
  lock —— 本 amendment 只声明 Poppo / Vone *目前* 不可达。

### 2026-05-28 · v2-F.3 list_elements / capture.annotateElements filter(翻案 + 设计 lock)

**翻案说明:**

- 原决策(§ Open implementation decisions #4):"`list_elements` 是否接受
  `clickableOnly?: boolean` 入参?**倾向**:不加;agent client-side filter 已足够,
  加这个 param 容易诱导 agent 漏掉 scrim"。
- 新决策(本 amendment):**加** `filter?: ElementFilter` 入参,涵盖
  `clickableOnly` / `classContains` / `textContains` / `contentDescContains` /
  `inViewport` 五个字段(Round 1 fold-in 把原稿 4 字段补齐 `contentDescContains`,
  icon-only Search 类节点 server-side 可达);同样形状的 filter 同步加到
  `android_debug_capture` 的 `annotateElements:true` 路径(两 tool 引用同一 zod
  对象,避免 schema drift)。**不加** pagination `cursor`;`limit` 在 filter
  后切尾。
- 触发原因:
  - v0.5.0 ship `capture.annotateElements:true` 之后,annotate 把 `Element[]`
    完整 spread 到 `annotation.elements`,**同一份 60-80 元素数组现在出现在
    capture 响应中**(v2-F.0 lock 时这只在 list_elements 出现)。Element 数组
    实测 15-40 KB(60-80 elements × 文本字段),capture 加 annotate 后单次响应
    token 翻倍。
  - 原决策的 "client-side filter 已足够" 在 v0.5.0 ship 前是成立的(token 成本
    一次性),但 annotate 之后变成"每次 capture 都吃这个成本";server-side
    filter 是把 wire 上的 byte 真正减下来,**不是** "agent 自己挑哪些用"。
    这跟 v2-G.1 Block B 的 `previewForAgent` 同根:agent 不该有"我自己挑"的
    选择 — 应该 server 端就把 wire 形态收紧,agent 显式付代价才拿全。
  - "诱导 agent 漏掉 scrim" 这条原顾虑 scope 重审:`clickableOnly:true` 实际
    **保留** scrim(scrim 通常 `clickable:true`);真正会丢 scrim 的是
    `textContains` / `classContains`(scrim 无 text、class 不常见词),那是
    agent 主动决定的 narrow,与 v2-G.1 narrowingFilter 同体例。Description
    显式提醒 agent "filter 是付费 narrowing,过窄会漏 scrim/intercept 层"。

**影响范围:**

- `server/src/mcp/tools/list_elements.ts` — inputSchema 加 `filter?: ElementFilter`,
  handler 调 `collectCurrentElements()` 之后切;输出 schema 加 `truncated?: true`
  warning when filter+limit cut elements off。
- `server/src/mcp/tools/capture.ts` — inputSchema 加 `filter?: ElementFilter`
  (与 list_elements 同 zod object,共享 import);仅在 `annotateElements:true`
  时生效(`annotateElements:false` + filter 同传 → `query_malformed`);filter 后
  的 element 集既用来 annotate 也作 `annotation.elements` 输出。
- `server/src/ui/list_elements.ts`(或新 `server/src/ui/element_filter.ts`)—
  共享 `applyElementFilter(elements, filter, viewport)` 纯函数 + `ElementFilterSchema`
  zod 导出。两 tool import 同一处。
- viewport 来源:`adb shell wm size` per call(~50ms,可接受;不缓存,避免
  fold-screen / rotation 失效)。仅当 `filter.inViewport === true` 时探。
- 不动 `Element` schema(`list_elements` 返回字段不变,filter 仅截短数组)。
- 不动 `list_elements` event(`elementCount` 报的是 **filter 之后** 的数,
  附加 `unfilteredCount: number` 字段反映原始数 — agent / 事后审计需要)。

**Q-decisions(本 sprint 内 lock):**

#### F3-Q1:filter 字段集

**Decision(Round 1 修订):五字段 `{clickableOnly, classContains, textContains,
contentDescContains, inViewport}`,全 optional;无 filter 字段时退化为 v2-F.0
行为(全集返回)。**

```ts
// 共享 zod object,list_elements + capture 都引用
const ElementFilterSchema = z
  .object({
    clickableOnly: z.boolean().optional(),
    classContains: z.string().min(1).max(255).optional(),       // 大小写不敏感 substring on Element.class
    textContains: z.string().min(1).max(255).optional(),        // 大小写不敏感 substring on Element.text
    contentDescContains: z.string().min(1).max(255).optional(), // 大小写不敏感 substring on Element.contentDesc
    inViewport: z.boolean().optional(),                         // 与设备 viewport 相交(intersect,非 fully-inside)
  })
  .strict();
```

不加 `focusableOnly` / `checkableOnly`(YAGNI;agent 几乎不按这两字段筛)。
不加 `hintContains`(Poppo/Vone hint 结构性为 null,见上一 amendment;非 Poppo app
未来真有需要再补)。

**Round 1 amendment(codex STOP 2026-05-28 #1):** 原 F3-Q1 漏了
`contentDescContains`,理由写"可由 textContains 覆盖大部分" —— 错。`Element.text`
与 `Element.contentDesc` 是 schema 上两个独立 nullable 字段(`server/src/ui/list_elements.ts:27-30`
与 `:88-91`),text 为空、仅 content-desc 标识的 icon-only button(如 Material
"Search" magnifier)在 textContains 上无法命中。证据:现有测试 fixture
`server/tests/mcp/capture_annotate.test.ts:18-23` 就有 `text:"", content-desc:"Search"`
的 element,本 amendment 加入 contentDescContains 后这类节点能 server-side narrow。
`contentDesc` 与 v2-F.0 § 文档定位 第 14 行 / Q5 / Element schema / acceptance 都
锁过是 first-class 信号,缺它是 contract 漏洞,不是 YAGNI。

#### F3-Q2:filter 是 AND 还是 OR 组合?

**Decision:AND(全部 satisfied 才入 page)。**

与 v2-G poppo_http.matchQuery 同体例。OR 形态在 list_elements 场景没有清晰
agent use case(agent 通常想"既 clickable 又含 Login 字样")。AND 之 narrow
正是 sprint 的 token 节省目的。

#### F3-Q3:textContains / classContains 是否大小写敏感?

**Decision:全部大小写不敏感(case-insensitive)。**

- `class` 字段是 Java FQCN(`android.widget.Button` 等),大小写虽通常稳定,
  但 agent 写 `"button"` 应该匹配。
- `text` 字段是用户可见字符串,case-insensitive 更友好。
- 实现:`element.text.toLowerCase().includes(query.toLowerCase())`,impl 简单。

#### F3-Q4:`inViewport` 是 intersect 还是 fully-inside?

**Decision:intersect(任何像素在 viewport 内即留),半开矩形 boundary。**

- Fully-inside 会丢 scrolled-list 边缘元素(bounds 部分超出屏幕但仍可 tap 中心)。
- Intersect 与 agent 实际意图(找"可见可达"元素)一致。
- 实现(Round 1 修订,half-open `[left, right) × [top, bottom)`,与
  `server/src/ui/hit_test.ts:133-135` 现有 hit-test convention 对齐):
  ```ts
  !(bounds.right <= 0 || bounds.left >= viewport.w
    || bounds.bottom <= 0 || bounds.top >= viewport.h)
  ```
  原稿写 `<0` / `>w` / `<0` / `>h`,会让 bounds 刚好贴在右/下边界(零重叠)
  也算 intersect — 与 hit-test 半开矩形不一致。

Viewport 由 `adb shell wm size` 探(stdout 形如 `Physical size: 1080x2400` /
`Override size: 1440x3120`)。Override 优先,fall back to Physical。探失败 →
`filter.inViewport` no-op + 返 `warnings: ["viewport_unknown"]`,**不**报错
(uiautomator dump 仍正常返,agent 自己决定要不要按 bounds 筛)。

**Round 1 amendment(codex advisory 2026-05-28 #1):** 视口算法改为半开矩形,
与 hit-test 同 convention。单元测试覆盖 edge case:bounds 触右/下边但零重叠(reject)、
触左/上边但零重叠(reject)、部分重叠(keep)、完全在外(reject)、完全在内(keep)。

#### F3-Q5:pagination 是否引入 `cursor`?+ `limit` 公契约

**Decision:不引入 cursor。`limit` 切尾 + `truncated:true` warning 即可。**

- list_elements 每次都跑 fresh dump(§ "Do not cache" 显式),cursor 跨调用
  没有 stable identity 可锚 — 下次调用 captureId 必然不同,cursor 失效。
- 引入 cursor 会强制 server 缓存 element 数组(违反 § "Do not cache" 与
  open decision #2 "不加 id 避免诱导 replay"),设计成本远大于收益。
- 替代方案:agent 拿到 `truncated:true` → 加紧 filter narrow → 重 call。这正是
  v2-G.1 narrowingFilter 已经验过的 agent loop 形态。

**`limit` 公契约(Round 1 amendment,locked in this sprint;Round 2 修订
zod 链顺序):**

```ts
// 共享 zod fragment,list_elements 与 capture(annotateElements:true)同 import
const elementLimitSchema = z.number().int().min(1).max(500).default(100);
```

`.default(100)` **不**追加 `.optional()` —— zod 行为:`.default(100).optional()` 解析
`undefined` 仍返 `undefined`(`.optional()` 包在外层覆盖 default);单 `.default(100)`
解析 `undefined` 返 `100`,且 TS-level input 视为可选(caller 仍可省略)。与
`server/src/mcp/tools/search_evidence.ts:39-44` 和 `extract_evidence_context.ts:65-70`
现有 v2-G evidence `limit` 形态完全一致。

**Round 2 amendment(codex STOP 2026-05-28 blocking #1):** 原 Round 1 写
`.default(100).optional()`,链顺序错 — `parse(undefined)` 返 undefined 不是 100,
agent 省略 `limit` 时 handler 拿到的是 undefined 而非默认值,违反 "默认 100" 公契约。
Codex 现场 `bun -e` 验过,本地复现一致(`default(100).optional()` → undefined,
`default(100)` → 100,`optional().default(100)` → 100)。最终落点:删 `.optional()`,
与 v2-G 现行 evidence limit 同体例;Phase 1 test 显式 assert 两 tool 上 omitted
`limit` 都解析为 100(不是仅断言 "limit is optional")。

- 类型:`number`,integer,1–500 inclusive,default 100。
- 0 是 invalid input(min 1)— 与 v2-G evidence search `limit` 同体例;`limit:0`
  / `limit:-1` 在 zod parse 阶段被打回。
- 默认 100 略大于 v2-F.0 实测最大 80 元素,正常一屏 dump 不会触发 truncate;
  agent 主动收紧 filter 时仍可显式传更小值。
- **两 tool 同共享 schema**:`list_elements` 与 `capture({annotateElements:true})`
  都接受 `limit`,**绝不 drift**(共用 zod import,Phase 1 实施时如发现 drift =
  bug)。
- `capture` 上的 `limit` 仅在 `annotateElements:true` 时有意义:同 filter,
  `limit` 配 `annotateElements:false`/缺 → `query_malformed`(handler-side guard,
  与 F3-Q7 同体例)。

**Round 1 amendment(codex STOP 2026-05-28 #2):** 原 F3-Q5 只说 "limit 默认 100",
未具化 zod fragment、min/max、`0` 边界、是否两 tool 共享。codex 抓为 public
contract 漏洞:Phase 1 实施可能 drift(`list_elements` 与 capture 走不同 schema /
不同 default / 不同 error message)。最终落点:本段加 `elementLimitSchema` zod
fragment + 显式两 tool 同共享 + `0` 由 zod 强制 ≥1 + 两 tool 边界一致;
F3-Q7 capture 的 `query_malformed` 形态扩到也包含 `limit without annotateElements:true`。

**Round 3 amendment(post-cut audit 2026-05-28 #3,v0.5.3 修订):** 上述
"两 tool 同共享 schema" 与 F3-Q7 strict reject 在 v0.5.2 实施时撞了:
`elementLimitSchema = z.number().int().min(1).max(500).default(100)` 让 capture 的
handler post-parse 拿不到 "caller 有无 supply" 信号(default 把 undefined 替换为 100),
所以 handler 用 `input.limit !== 100` 当 explicit signal —— `{limit:100}`(=default)
绕过 reject,违反 F3-Q7 "`limit !== undefined` → reject"。最终落点:
**capture 用 raw-optional 变体 `captureElementLimitSchema = z.number().int().min(1).max(500).optional()`**
(无 default,handler 在 annotate 路径自行应用 100 默认值);**list_elements 不动**(继续用
`elementLimitSchema` 自带 default,因为 list_elements 没有"未 supply"特殊语义)。**共享
的是 bounds**(`elementLimitBounds = z.number().int().min(1).max(500)`,两变体都从此 wrap),
**不共享** default 应用。Capture regression test pin `{limit:100}` without `annotateElements`
→ `query_malformed`。

**Round 3 amendment(post-cut audit 2026-05-28 #1+#2,v0.5.3 修订):** v0.5.2 实施时
两条 contract drift codex 抓:
  - **#1 capture tool description 没同步 v2-F.3**:Args / Returns / Errors 仍是
    v0.5.0 ship 文字,不提 `filter` / `limit` / `annotation.{unfilteredCount,
    filteredCount, truncated?, warnings?}` / `query_malformed when filter/limit
    without annotateElements`。Description 是 agent-facing 契约文本,与 strict
    inputSchema 并列对 LLM 公开 —— 模型读 description 决定怎么 call,description
    必须 mirror schema + handler reject 行为,否则 schema strict 拒绝时 agent
    不知道为什么。(Round 2 verify amendment:原稿误写 "inputSchema `.passthrough()`",
    实际 capture 用 `.strict()` 配 `ElementFilterSchema.strict()`,
    `server/src/mcp/tools/capture.ts:24-42` + `server/src/ui/element_filter.ts:36-44`。
    `.passthrough()` 是 `search_evidence` 的形态,与 capture 无关 —— 误植已 fix。)
    Fix:capture description 与 list_elements description 对齐,显式列五字段 filter
    + limit 边界 + annotation 块字段 + 所有 query_malformed 触发条件。
  - **#2 capture event/commands audit 字段没落 disk**:F3-Q8 lock 显式说
    capture 的 events.jsonl + commands.jsonl 行也加 `unfilteredElementCount /
    filteredElementCount / filter? / limit? / truncated?`,但 v0.5.2 handler
    `appendCommand` + `appendEvent` 只写了 `{tool, captureId, kinds, annotated}`,
    audit consumer 拿不到 filter/limit/counts 反推"为啥这次 annotate 少返"。
    Fix:handler 在 annotate 分支末把 unfilteredCount / filteredCount / truncated
    缓存到 outer scope,`appendCommand` + `appendEvent` 走同一 `annotateAuditFields`
    spread,只在 `wantsAnnotate === true` 时写;非 annotate path 不污染审计行。

#### F3-Q6:filter 与 v2-F.2 (c) `annotateElementIds?` 的关系?

**Decision:不同轴,可共存,本 sprint 只做 filter(server-side 截短),
`annotateElementIds` 推 v2-F.2 sprint。**

- filter:server 端"产 list 时直接少返";byte 真减。
- `annotateElementIds`:server 已产 list 后,annotate 时"只画指定 N 个 badge"
  + (可选)只返这 N 个的 mapping;byte 减第二刀。
- 两者正交且都有意义。本 sprint 先做 filter,annotate iteration 留 v2-F.2。

#### F3-Q7:capture.annotateElements + filter / limit 组合的边界

**Decision:`filter` 和 `limit` 字段在 capture 上**仅当** `annotateElements:true`
才有意义;`filter` 或 `limit` 同传但 `annotateElements:false` / 缺 →
`query_malformed`。**

- 同 v0.5.0 已建立的 "annotateElements 需要 screenshot kind" 形态;handler-side
  guard(`.refine()` 进不去 inputSchema § G-4)。
- 拒绝形态:三种合一条 handler check —
  `wantsAnnotate === false && (filter !== undefined || limit !== undefined) → throw`。
- filter 后的 element 集既参与 annotate badge(每条 → 一个数字编号),
  也作 `annotation.elements` 输出 mapping — 两者必须基于同一 filtered+truncated 集合,
  byte-equiv 不动 v0.5.0 已 lock 的 invariants。
- annotation badge 数字编号 = 同次响应内 filtered+truncated 集合的 1-based index
  (v2-F.1 § Q5 体例不变;filter 只是改变进入这个集合的元素子集)。

#### F3-Q8:输出 schema 增量(Round 1 修订:`truncated` 改用 postFilter)

**Decision:**

```ts
// list_elements outputSchema 增量:
{
  ...existing fields,
  unfilteredCount: number,        // pre-filter element count(= dump 原始数量)
  filteredCount: number,          // post-filter, pre-truncate count
  truncated?: true,               // 当 filteredCount > elements.length(即 limit 真正切掉了 ≥1 条)
  warnings?: string[],            // 当前仅 "viewport_unknown" 一种
}

// list_elements event 增量(events.jsonl):
{
  ...existing fields (captureId, elementCount, windowCount, label?),
  unfilteredCount: number,        // pre-filter
  filteredCount: number,          // post-filter, pre-truncate
  filter?: ElementFilter,         // echo 原 input filter(便于 audit)
  limit?: number,                 // echo 原 input limit
  truncated?: true,
}

// capture annotateElements 路径上:
{
  ...,
  annotation: {
    ...existing fields (screenshotPath, elementCount, error, elements),
    unfilteredCount: number,      // pre-filter
    filteredCount: number,        // post-filter
    truncated?: true,
    warnings?: string[],          // viewport_unknown 等;capture 上独立 channel(不破顶层 outputSchema)
  }
}
// capture event(events.jsonl)+ commands.jsonl row 同样加 unfilteredElementCount /
// filteredElementCount / filter? / limit? / truncated? 字段。
```

`elementCount` 字段语义不变(等于 returned `elements.length`);
**`unfilteredCount`** = 扫出但未过 filter 的原始数;
**`filteredCount`** = 过 filter 但未 truncate 的中间数;
**`truncated`** 仅在 `filteredCount > elements.length` 时存在(i.e. limit 真的
切掉了 ≥1 条 post-filter 命中)。
Agent 可以算 narrowness = `filteredCount / unfilteredCount`;agent 看 `truncated:true`
知道"应收紧 filter 再 call"。

**Round 1 amendment(codex STOP 2026-05-28 #3):** 原 F3-Q8 把 `truncated` 定义
为 "elements.length === filter limit < unfilteredCount" —— 假阳性。反例:raw 80
elements,filter 命中 1 条,limit=1 → returned.length===1, limit===1, 1<80,
formula 说 truncated:true,但实际什么都没被切。Agent 看到误 signal 会无谓收紧
filter / 误判没拿全。最终落点:**改用 `filteredCount`(post-filter pre-truncate
中间量)和 `elements.length`(post-truncate)做差值**,`truncated:true` 仅 iff
`filteredCount > elements.length`(对应"limit 实际切掉了 ≥1 条 filter 命中")。
schema / event / commands.jsonl 同步加 `filteredCount` 字段 expose audit consumer。

**Round 1 amendment(codex advisory 2026-05-28 #2):** 原 F3-Q8 只在
`list_elements.outputSchema.warnings?` 给了 `viewport_unknown` channel,capture
路径无 channel,导致 `capture({annotateElements:true, filter:{inViewport:true}})`
在探测失败时无处 surface warning。最终落点:capture 的 `annotation` 嵌套块加
`warnings?: string[]`,与 list_elements 的 top-level `warnings?` 同形;capture
上的 viewport_unknown 走 `annotation.warnings`,不破 capture 顶层 outputSchema(顶层
保留 v0.5.0 ship 的 strict shape)。

**Tool description 增量:**

- list_elements:加 "Use `filter` (clickableOnly / classContains / textContains /
  contentDescContains / inViewport) to narrow at server-side — agents that read
  truncated:true should apply a tighter filter and re-call. Filters compose as AND."
- capture(annotateElements path):同样描述 + "filter on capture only takes
  effect when annotateElements:true; otherwise → query_malformed."

**Test coverage 计划(grill GO 后):**

- `server/src/ui/element_filter.ts` 新模块 + `server/tests/ui/element_filter.test.ts`
  - 5 字段独立(`clickableOnly` / `classContains` / `textContains` /
    `contentDescContains` / `inViewport`)+ AND 组合
  - case-insensitivity 三处验证(`classContains`、`textContains`、`contentDescContains`)
  - **icon-only content-desc 命中**:fixture `text:"", contentDesc:"Search"` 用
    `contentDescContains:"search"` 应命中(对齐 codex Round 1 #1 引用的现有
    `server/tests/mcp/capture_annotate.test.ts:18-23` fixture pattern)
  - viewport intersect 半开矩形边界:bounds 触右/下边零重叠(reject)/ 触左/上边
    零重叠(reject)/ 部分重叠(keep)/ 完全在外(reject)/ 完全在内(keep)
- `server/tests/mcp/list_elements.test.ts` 或同 file 加 filter 端到端
  - 无 filter 退化(行为不变)/ 各 filter 字段端到端
  - `limit` 边界:default 100、传 0 → zod reject (query_malformed)、传 501 → zod reject
  - **truncated 正确性**(对齐 codex Round 1 #3):
    - raw=80, filter 命中 80, limit=10 → `truncated:true`,
      `filteredCount:80, elements.length:10`
    - raw=80, filter 命中 1, limit=1 → `truncated` 缺(假阳性回归),
      `filteredCount:1, elements.length:1`
  - viewport_unknown warning(注入 mock 让 `wm size` 探测失败)
- `server/tests/mcp/capture_annotate.test.ts` 加 filter + annotateElements
  对称行为:
  - filter + `annotateElements:true` → filtered annotation.elements + 一致的 badge id 编号
  - `filter without annotateElements:true → query_malformed`
  - `limit without annotateElements:true → query_malformed`(同 reject 路径)
  - `annotation.warnings` 包含 `viewport_unknown`(同 mock 注入)

**实施分期(轻量,1-2 phase):**

- **Phase 1**:`element_filter.ts` 新 module + zod 共享 schema + 单元测试;
  list_elements 接入 filter + truncated/warnings + unfilteredCount + filteredCount;
  capture 接入 filter + 边界 reject + capture event/commands.jsonl 字段
  (含 `filteredElementCount` 镜像)。无独立 phase audit,合并到 final audit。
- **Phase 2**:codex post-impl audit + 真机 acceptance(Poppo Vone 几屏跑下来
  filter 各字段 + truncate path)。GO 后 cut **`v0.5.2`**。

**Release 节奏:**

- 单 cut,版本号 **`v0.5.2`**(per handoff "cut 0.5.2 或并 v2-G.1 同 cut" 的前者)。
- release note 显著提示三点:
  - `list_elements` 加 `filter` + `limit` + `unfilteredCount` + `filteredCount` +
    `truncated` 字段(向后兼容,全 optional)
  - `capture` 在 `annotateElements:true` 路径上接受同样 `filter` + `limit` 字段;
    `annotation` 块加 `unfilteredCount` / `filteredCount` / `truncated?` /
    `warnings?`
  - `list_elements` event 增 `unfilteredCount` / `filteredCount` / `filter?` /
    `limit?` / `truncated?` 字段(audit consumers 可能要适配)

**与 v2-G.1 sprint 隔离:** v0.5.1 已经 cut。本 amendment 与 v2-G.1 contract 完全
独立(filter 在 UI 探索面;preview 在 evidence 读面),不会互扰。
