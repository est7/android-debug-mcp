# Backlog · v1.1 / v2 / v3

Living document. 每条 backlog 含 motivation(引用源)+ 触发条件(什么时候启动)+ 未决问题。
触发条件成立 → 把对应条目 promote 到独立设计文档(如 `docs/v2/source-mapping.md`),从本表划掉。

源头:[`../suggestion-chat.md`](../suggestion-chat.md)、[`design-lock-v1.md`](./design-lock-v1.md)。

---

## v0.6.0 sprint 候选(本会话 handoff,详见 [`v0.6-handoff.md`](./v0.6-handoff.md))

下一轮 cut 候选,按"agent 用着真有感"轴(命中准确性 / token 节省 / 调用次数减少)
排进 sprint。**Tier 1 必做,Tier 2 视余量**。每条都 link 到本表里独立 entry。

### Tier 1(已完成)

- ✅ **v2-G.1 Block B** —— `previewForAgent` 单条 record 截断 — **closed in v0.5.1**
  (真机实测 76% byte 压缩 across 7/50 truncated records)
- ✅ **v2-G.1 Block A 收紧** —— `tsMsRange` 双 bounded + 24h cap + `bindSession`
  不合成 — **closed in v0.5.1**(同 cut)
- ✅ **v2-F.3** —— `list_elements` + `capture.annotateElements` server-side filter
  (clickableOnly / classContains / textContains / contentDescContains / inViewport)
  + limit truncate + viewport_unknown warning — **closed in v0.5.2**(真机 54-element
  notification shade 10/10 acceptance pass)

### Tier 2(本 sprint 未启动 — carry)

- **v2-F.2** —— annotate iteration:badge collision avoidance + text labels in badges + `annotateElementIds` subset filter → 见下方独立 entry
- **v2-G.2** —— `search_logs` aggregation(`{groupBy, count, top}` 把"哪种 error 最多"挪 server 端,省 token 又省 round-trip)→ 见下方独立 entry
- **v2-A.1** —— `map_ui_node_to_source` confidence threshold filter(server 端筛低置信度 candidate,agent 不被噪声误导)→ 见下方独立 entry

### Tier 3(本 sprint 不动,记录留档)

详见各条目下"Tier 3"标记:
- **v2-misc · session-level cache of list_elements**(UI hash gated)— 调用次数 ↓,有缓存失效复杂度
- **v2-misc · `events.jsonl` 读端 filter**(`?sinceTs / ?type / ?textContains`)— `get_run_summary` token ↓
- **1.1-F · `getLocksRoot` test hermeticity env override**— 测试 infra 卫生
- 以及既有 Tier 3:v2-A Phase 2 Compose / v2-E bundle 上传 / v2-B auto-replay / v2-H source-recipe 抽离 / v3-A sidekick / v3-B IDE 索引 / v3-D 绕 logd

---

## v1.1(短期补强,v1 done 后立刻能开始)

### 1.1-A · `bun build --compile` 二进制 release

- **Motivation**:v1 是 bun-from-source,外部用户(不熟悉 Bun)上手成本高。`bun build --compile --target=bun-darwin-arm64` 产单二进制,GitHub Releases 一拖即用。
- **触发条件**:v1 5 个 scenario 全跑通 + 至少有 1 个非自己人的同事想用。
- **未决问题**:Linux x64 与 macOS arm64 双平台 release pipeline 怎么搭(GitHub Actions matrix?手 build 后 upload?);二进制内 adb path resolution 是否与 source 模式一致。

### 1.1-B · `docs/architecture.md`

- **Motivation**:v1 lock 只列决策,未画图。新人(或半年后的自己)看代码时仍需要架构脑图。
- **触发条件**:v1 done 后立刻补;早于第一次外部 contributor。
- **内容应含**:session 生命周期状态机、双通道 logcat 数据流、orphan recovery 时序、跨 host 配置示意。

### 1.1-C · Emulator-based CI integration test

- **Motivation**:v1 测试策略是"unit + 手动 integration",手动跑 scenario 容易漏。
- **触发条件**:出现一次"实现里改了什么,scenario X 默默坏了"的 regression。
- **未决问题**:GitHub Actions runner 上跑 emulator 的成本与稳定性(Android Emulator 启动慢、片状失败常见);是否需要自托管 runner;scenario E(orphan)如何在 CI 里 `kill -9` MCP。

### 1.1-D · `resolveRunDir` 跨 runRoot 找不到(v0.4.0 acceptance 实测)— ✅ **closed in v0.4.1**

- **Resolution**:Option B(per-run symlink index)落地。每个 `start_session` 在 `~/.android-debug-mcp/run-index/<runId>` 写 symlink 指回真 runDir;`resolveRunDir` 在 active miss 后通过 `readMetadata + runId equality check` 验证后返回。codex round 1 STOP 抓到 cross-runId pollution(stat-only validity check 会让 `<index>/<runIdA> → runDir(metadata.runId=runIdB)` 错误返回 B),round 2 GO。env override `ANDROID_DEBUG_MCP_INDEX_ROOT` 与 `ANDROID_DEBUG_MCP_RUN_ROOT` 平行,README 已 doc。
- **Commit / cut**:v0.4.1(`feat(server): per-run symlink index for cross-runRoot resolveRunDir` + test + chore)。
- **跨 host punt 仍有效**:streamable HTTP 落地后才考虑;symlink 是本机 home,不跨 host。

### 1.1-F · `getLocksRoot` test hermeticity env override(parallel 1.1-D fix)— **Tier 3**

- **Motivation**:v0.4.1 实施时给 run-index 加了 `ANDROID_DEBUG_MCP_INDEX_ROOT` env override + per-process tmp dir setupFile,让 run-index 测试 hermetic。`getLocksRoot()`(`server/src/store/paths.ts:125`)**仍**硬编码 `~/.android-debug-mcp/locks/`,lock 测试直接写真用户 home,每次 run 留污染。
- **触发条件**:整理 test infra / lock 测试 / 出现一次"上次 run 的 lock 残留导致这次失败"的 regression。
- **方案候选**:对齐 run-index 模式 —— `ANDROID_DEBUG_MCP_LOCKS_ROOT` env var,setupFile 注入 per-process tmp。~30 LOC + 改一行 test。
- **未决问题**:无,纯执行决定。

### 1.1-E · `node:fs/promises.mkdir` ESM-frozen test gap(Phase 3 deferred)

- **Motivation**:`SessionManager.start` 在 mkdir 失败时要 cleanup(释放 lock + 回滚已建文件)。逻辑代码正确,但缺一条端到端测试 — 因为 `node:fs/promises.mkdir` 是 frozen ESM export,`vi.spyOn(fs, "mkdir")` 在 vitest 里被拒。codex Phase 3 / Phase 5 两轮 audit 都看到这条 deferred,均 accept(代码逻辑无争议、只是测试覆盖缺口)。
- **触发条件**:任一即可:
  1. vitest 升级到支持 ESM module mocking 的版本(可能要等 vitest 3 / 4)
  2. 自己换 DI 形态(把 `mkdir` 从静态 import 换成 manager 构造时注入的 fsLike 接口)
  3. 出现一次"mkdir cleanup 路径默默坏了"的 regression
- **方案候选**:
  - **A**:把 `node:fs/promises` 包一层 `fsService` 在 SessionManager 构造时注入。Constructor injection,test 给 in-memory fake。最干净,但牵动 SessionManager 构造签名(影响所有 caller)。
  - **B**:用 `vi.mock("node:fs/promises", ...)` 全模块 mock 一次,只覆盖这一条 test。损耗小,但全模块 mock 是 vitest 里有名的脆弱套路。
  - **C**:等 vitest 升级,什么都不做。
- **未决问题**:无,纯执行决定。

---

## v2(下一个 major milestone)

### v2-A · UI 元素 → 源码 mapping(tap-to-source)

> **Phase 1 设计已 promote** → [`v2/source-mapping.md`](./v2/source-mapping.md)(2026-05-21 grill 锁定 Q1–Q10 + codex 2 轮复审)。本条目保留 Phase 2(Compose)与历史背景。

- **Motivation**:[`suggestion-chat.md` § "你的补充把优先级改了:最有价值的不是再多收集一点设备信息..."](../suggestion-chat.md)。用户原话"点击哪个元素 → 定位到代码位置"。FixThis 项目 `https://github.com/beyondwin/FixThis` 是相关参考实现。
- **核心数据形态**:
  ```
  tap event
    → nearest UI node by bounds
      → resource-id / testTag / semantics
        → screen owner
          → source candidates (file + line + reason + confidence)
  ```
- **新增 tool 候选**:`record_next_tap` / `find_ui_node_at` / `map_ui_node_to_source` / `compare_ui_before_after`
- **触发条件**:v1 在 Poppo / Vone / popposhell 上累计用过 ≥10 次 debug session,且至少 2 次出现"知道点的是 Login 按钮但不知道源码在哪"的真实需求。
- **依赖前置**:
  - View 项目:有效 `resource-id`(已有,Android 默认)
  - Compose 项目(popposhell):需推 testTag 工程规范——v2 启动前先在 popposhell 组内达成共识
- **实施分期(2026-05-21 grill 锁定)**:
  - **Phase 1 — View-first(Poppo / Vone)**:`resource-id` 是 Android 默认产物,零前置,`坐标 → 节点 → resource-id → 源码` 解析链立刻可跑;误匹配率低,先在此基底上把 confidence 算法调出可信 baseline。v2-A v1 即此阶段。
  - **Phase 2 — Compose-first(popposhell)**:popposhell 的 Compose 重构是项目**已确定的未来方向**,v2-A 终局必然转向 Compose。Compose 无 `resource-id`,节点身份依赖 `testTag` / semantics。**触发条件**:Phase 1 在 View 上跑出真实用量数据 + popposhell 组内落地 testTag 工程规范。
  - 决策依据:不是「押 View、弃 Compose」,而是把 Compose 的组织依赖(testTag 规范)移出 milestone 关键路径——用 Phase 1 的数据反过来论证 Phase 2 的投入。
- **未决问题**:
  - 第一版用 `rg` 模糊匹配,还是直接接 JetBrains MCP / LSP?suggestion-chat 推荐 `rg` 起步,但 popposhell 用 Compose,误匹配率可能比 View 高
  - confidence / margin score 算法:nearest-bounds 命中 + identifier 出现频次 + 文件距离 (`screen owner` 的同包名优先?)
  - source mapping 的结果是否进 events.jsonl(让 agent 拿到 tap event 时立刻看到 source candidates),还是单独 tool 按需查询?
- **风险**:rg 误匹配会让 agent 拿到错的源码 candidate,debug 数据信噪比反而下降——v2 上线前必须有 confidence 阈值 + UI 提示"低置信度,请人工确认"

### v2-A.1 · `map_ui_node_to_source` confidence threshold filter — **v0.6.0 Tier 2**

- **Motivation**:v2-A v1 现在把全部 candidate 一股脑返,agent 自己挑;低置信度
  candidate 干扰 agent 决策。Server 端筛掉 `confidence < threshold` 的 → agent
  context 干净,误判率 ↓。命中 ✅✅。
- **新增 input fields**:
  - `minConfidence?: number`(0..1,默认 0 即不过滤,保 v2-A v1 行为)
  - `top?: number`(返 top-N candidate by confidence)
- **触发条件**:**v0.6.0 Tier 2**(视余量)。即便 v2-A 仍在 Phase 1 View,filter
  已可用 —— 不依赖 Phase 2。
- **未决问题**:default threshold(0 / 0.3 / 0.5)?是否同步加进 `tap_node`
  (它内部也调 source mapping)的响应?
- **风险**:agent 习惯了 "candidate 列表很短" 后,真有 corner case 命中所有低置信度
  的时候反而拿不到提示 —— 是否要在 `error: "all_below_threshold"` 时退化为
  返 top-1 + warning?

### v2-B · Agent-driven auto-replay

- **Motivation**:v1 锁了"人工默认 + 自动化前瞻",interaction tool 已经是 session-aware,但 agent 不会自动复现一整条 reproduce steps。
- **新增能力**:`replay_steps(runId, steps[])`(顺序执行 tap/swipe/input + 中间 capture UI,任一步骤前后状态校验);或更轻量的 `agent_loop` mode(agent 自决策每步、MCP 提供 step-level evidence)。
- **触发条件**:v2-A 完成后,且出现"同一 bug 复现 5 次都要人工点 7 步"的具体场景。
- **未决问题**:真机 UI 自动化漂移(权限弹窗 / 网络波动 / 动画时序 / ime 切换)怎么处理?重试策略?stabilization wait 策略(等待哪个 UI element 出现才继续)?
- **风险**:稳定性差时会变成"agent 假装跑完了一遍其实第 3 步就漂了"——必须有 step-level verification 而不是盲跑

### v2-C · 多设备并发 session

- **Motivation**:v1 是 (device, package) 单例;`MacBook 上同时 emulator-5554 + 物理机` 是真实需求(对比测试 / 多渠道并行)
- **触发条件**:出现至少 1 次"我需要同 host 同时调试两个设备"的真实需求
- **未决问题**:`stop_session({ runId? })` 在多 active session 下省略 runId 时怎么处理(reject?返回 active list?);run folder 之间的隔离已经天然成立(以 deviceSerial 间接分隔),但 lockfile 模型要重做

### v2-D · Streamable HTTP transport

- **Motivation**:跨机器场景(MCP server 跑在 Mac,agent host 跑在 remote 设备)
- **触发条件**:出现明确的远程 agent 场景(不是"以后可能",而是"下周三 demo 需要")
- **未决问题**:认证(谁能连进来)、session 状态共享(多 host 看到同一 session 还是各自独立)

### v2-E · Bundle 自动上传 / 共享

- **Motivation**:[`suggestion-chat.md` § "尤其你以后如果让 agent 自动上传 bundle 给 Claude/Codex/Gemini"](../suggestion-chat.md)
- **新增 tool**:`upload_bundle(runId, destination)`(S3 / GCS / 内部存储)
- **触发条件**:bundle 已经被人手动通过其他方式上传过 3 次(说明需求成立)
- **未决问题**:**redaction 必须在上传前再过一遍**——v1 默认 redaction 只覆盖 events / commands,未覆盖 logcat 本身。上传场景下需 secondary scan(logcat 里出现的 Authorization / Cookie 必须再脱)。这是上传功能的**前置阻塞条件**

### v2-F · Element-based interaction(已 promoted)

> **设计 lock + 实施已 promote** → [`v2/element-interaction.md`](./v2/element-interaction.md) + [`v2/v2-f-implementation-plan.md`](./v2/v2-f-implementation-plan.md) + [`v2/test-plan-v2f.md`](./v2/test-plan-v2f.md)。2026-05-25 final codex audit round-2 sign-off 在 `943d1cf`,close sweep follow-up `cdf6cb6`。v2-F.0 随 0.4.0 上线;v2-F.1 (screenshot annotate) 上线 v0.5.0,见下方 § v2-F.1。
>
> 历史 motivation / 触发条件 / 方案对比留档:
>
> - 原 motivation:v1 的 `tap` / `swipe` 是坐标级,Element-based("点击文本为 Login 的按钮")更稳。参考 [`mobile-next/mobile-mcp`](https://github.com/mobile-next/mobile-mcp)。
> - 最终方案:Route B(list + coord),`list_elements` 返全屏 element flat list,agent 选 coord 后用 v1 `tap` / 新 `long_press` 分发。**不引入 selector 概念**;不嵌入 mobile-mcp 子进程。
> - 实施分期:Phase 1 View-first(Poppo / Vone)— 已 land;Phase 2 Compose-via-testTagsAsResourceId — 推后续 popposhell opt-in 后启动。
> - v2-F.0 真机 acceptance 期产 3 条 lock-level amendments(见 element-interaction.md § Amendments):Scenario C multi-window 真机 MIUI 不可观察 / Q12 zod wire-shape transport-dependent / Scenario A `hint` Poppo 结构性不可达 (code-driven i18n)。

### v2-F.1 · screenshot element annotate — ✅ **closed in v0.5.0**

- **Resolution**:`capture` 加 `annotateElements?: boolean` + nested `annotation`
  output object;内部跑同 `list_elements` recipe,产带编号彩色 box 的第二张 PNG +
  `{annotationId, center, bounds, ...Element}` mapping。agent 看图 → 读 mapping →
  调 `tap_node({runId, x, y})`,**省了一次 `list_elements` round-trip**。
- **栈选择**:pngjs(pure JS,bun --compile 友好)+ 程序化 7-segment digit
  renderer(无 font asset 依赖)。否决 Jimp(font path bunfs 问题)和 sharp
  (native libvips 不能进 bunfs)。
- **Lock + provenance**:[`v2/annotate.md`](./v2/annotate.md) 11.6 KB,含 12
  Q-decisions + 10 acceptance scenarios + codex 5+2 轮 round-trip(STOP×4+1
  → GO)Amendments 全留痕。
- **Commit / cut**:v0.5.0(feat + test + docs + chore)。

### v2-F.2 · annotate iteration(badge collision + text labels + subset filter)— **v0.6.0 Tier 2**

- **Motivation**:v2-F.1 ship 后留 3 个显式 out-of-scope,每条都对 dense / nested UI
  下的 agent 体验有具体痛点。
  - (a) **Badge collision avoidance**(v2-F.1 § Q12 punt):密 UI 中两 inside badge
    可能撞同一像素区。5-档 corner fallback + 重叠检测,~80 LOC + collision-topology
    fixture。
  - (b) **Text labels in badges**:badge 现在只数字 ID,agent 仍需扫 mapping 找文本。
    badge 加 `Button / EditText / ...` element class 短形式或 element text 截断
    (`登录 →`)。命中 ↑ 因 agent 看图不脑链 JSON。但要装 TTF / atlas / 自渲染中文,
    与 7-segment digit-only 路线冲突 —— 实施时先决:ASCII-only 还是 i18n。
  - (c) **`annotateElementIds?: number[]` subset filter**:agent 已知关心哪 5 个
    元素 → 只画 / 只返这些。token ↓(尤其 mapping 字段全 spread Element 时显著)。
- **触发条件**:任一即可:
  1. v0.5.0 agent 反馈"badge 撞看不清"(a 触发)
  2. agent 反馈"光看数字记不住对应什么"(b 触发)
  3. 大 list 场景明确 agent 只关心 head-N 元素(c 触发)
- **方案候选 + 未决**:
  - (b) 走 TTF runtime 还是 build-time pre-raster 还是 ASCII 5×7 bitmap atlas
    —— 2026-05-27 spike 已比较;v2-F.2 启动时再选
  - (c) 与 (a)(b) 是否同一 commit / tag,还是 v2-F.2 三 sub-feature 分开 cut

### v2-F.3 · `list_elements` filter + pagination — ✅ **closed in v0.5.2**

- **Resolution**:`list_elements` + `capture({annotateElements:true})` 共享 5 字段
  `ElementFilterSchema`(`clickableOnly` / `classContains` / `textContains` /
  `contentDescContains` / `inViewport`)+ `elementLimitSchema`(`z.number().int()
  .min(1).max(500).default(100)`,**不**带 `.optional()` —— `.default(100).optional()`
  解析 undefined 返 undefined 不是 100,zod 链顺序问题,Round 2 codex 抓到)。
  AND 组合;case-insensitive substring;viewport intersect 半开矩形对齐 `hit_test.ts`。
  pagination cursor **不引入**:fresh-dump-per-call 无 stable identity,`truncated:true`
  warning + 收紧 filter 重 call 即可(同 v2-G.1 narrowingFilter 形态)。
- **新增 output 字段**:`unfilteredCount` / `filteredCount` / `truncated?` /
  `warnings?`(顶层 `list_elements` + `capture.annotation` 嵌套都加)。`truncated`
  定义:`filteredCount > elementCount`(不是 `filteredCount === limit < unfilteredCount`
  那个假阳性公式;Round 1 codex 抓到)。
- **viewport** 通过 `adb shell wm size` 探,`Override size` 优先 / `Physical size`
  fallback;探失败 → `viewport_unknown` warning,filter 对该字段 no-op,**不**报错。
- **与 v2-F.2 (c) `annotateElementIds`** 不同轴(filter = 产 list 时少返;
  annotateElementIds = 产 list 后只画子集),v2-F.2 sprint 启动时再做。
- **Lock + provenance**:[`v2/element-interaction.md`](./v2/element-interaction.md)
  § Amendments § "2026-05-28 · v2-F.3"。Codex 2 rounds STOP fold-in
  (`contentDescContains` / `elementLimitSchema` / `truncated` 公式 / 半开矩形 /
  `annotation.warnings` channel / zod chain 顺序 + 2 doc-drift fixes);
  Round 3 verify 因 codex 额度断电未发,Phase 1 自审 + 真机 acceptance 10/10 pass
  替代。
- **Commit chain**:`4fb1f41` Phase 1 + v0.5.2 cut。

### v2-G · Project profile + EvidenceSource adapter layer

> **设计 lock + 实施 promoted**(`HEAD = 42d048b` after Phase 5 (i)) → [`v2/profile-and-evidence.md`](./v2/profile-and-evidence.md) (design lock,Q1–Q12 + Phase 3/4/5 contract amendments) + [`v2/v2-g-implementation-plan.md`](./v2/v2-g-implementation-plan.md) (5-phase 实施) + [`v2/test-plan-v2g.md`](./v2/test-plan-v2g.md) (8 真机 acceptance)。Code surface 完整;只剩 Phase 5 (ii) 真机 acceptance + 0.4.0 tag。

### v2-G.2 · `search_logs` aggregation — **v0.6.0 Tier 2**

- **Motivation**:agent 在 debugging 高频出现"哪种 error 最多"/ "哪 tag 在 crash
  前 60s 内最密" / "Top-N 出现 token 是什么"等问题。现在只能拉全 log 自己 count,
  动辄一次几万 token。server 端 group + count 一次返一个汇总表 → token + round-trip
  两项一起省。
- **新增 input fields**(`search_logs` 扩参,默认行为不变):
  - `groupBy?: "errorType" | "tag" | "level" | "process"`
  - `count?: boolean`(true 时不返 record 列表,只返 `{group, count}[]`)
  - `top?: number`(配 `count:true`,返 top-N)
- **设计要点**:与 Block A narrowing-filter 共存(必须仍带 query / 时间范围);
  与 Block B previewForAgent 衔接(count 模式下不渲染 record body)。
- **触发条件**:v0.6.0 Tier 2(视余量)。若 Block B(Tier 1)实施时发现 aggregation
  能顺手做,可合并 sprint。
- **未决问题**:
  - groupBy 字段集是否要支持复合 key(`errorType + tag`)
  - 跨 EvidenceSource 是否要一致 aggregation 接口(Poppo HTTP 的 `outcome` 字段
    vs logcat 的 `tag`)
  - count 模式是否走单独 tool 名(`search_logs_aggregate`)还是同 tool 扩参

### v2-misc · session-level `list_elements` cache(UI hash gated)— **Tier 3**

- **Motivation**:agent 在同一屏短时间内多次问 element list / annotate(典型场景:
  "看完 list → 思考 → 再 capture 确认 → 再 tap")。Server 端 cache 上次结果,
  若 UI 未变(ui dump hash 相同)直接返。**调用次数 ✅✅。**
- **触发条件**:agent 实测频繁连续 `list_elements` / `capture(annotate)` 但 UI 不变
  时;或 token usage stats 显示 element list 在 context 里出现重复。
- **未决问题**:cache 失效策略(每次调用都 sniff hash → 仍要跑 dump,只省 parse/collect;
  完全跳 dump 的话需要 lifecycle 信号告诉 cache 何时过期);TTL?session 多 capture 后
  cache 大小;cache 命中是否要在响应里告诉 agent(`cached:true`)
- **方案候选**:
  - **A**:dump 后比 xml hash,命中 cache 直返,只省 parse/collect(~50ms)
  - **B**:tap / swipe / send_key 这些 mutator tool 调用后 invalidate cache,
    agent 不变 UI 时连 dump 都跳过(~250ms 省)。复杂度高,潜在错误也大
- **风险**:UI 在 cache 命中但真发生变(动画 / 异步刷新 / popup),agent 用旧 mapping
  调 tap 命中错位置。Option B 尤其要小心

### v2-misc · `events.jsonl` 读端 filter — **Tier 3**

- **Motivation**:`get_run_summary` 现在拉全 events,agent 自己过。一个长 session
  events.jsonl 可能 MB 级。server 端 filter 立省 90% token。
- **新增 input fields**(`get_run_summary` 扩参):
  - `eventTypesIn?: string[]`(`["capture", "crash"]`)
  - `sinceTs?: string`(events 时间戳过滤)
  - `textContains?: string`(模糊匹配 message / label)
- **触发条件**:用户实测 `get_run_summary` 单次响应 > 5k tokens;或 agent 报"events
  太多看不过来"
- **未决问题**:与 v2-G `search_logs` 是否合一(events 是 jsonl,跟 logcat / commands
  本质同 jsonl)→ 可能 v2-K · "通用 jsonl filter tool"

### v2-G · Project profile + EvidenceSource adapter layer

> **设计 lock + 实施 promoted**(`HEAD = 42d048b` after Phase 5 (i)) → [`v2/profile-and-evidence.md`](./v2/profile-and-evidence.md) (design lock,Q1–Q12 + Phase 3/4/5 contract amendments) + [`v2/v2-g-implementation-plan.md`](./v2/v2-g-implementation-plan.md) (5-phase 实施) + [`v2/test-plan-v2g.md`](./v2/test-plan-v2g.md) (8 真机 acceptance)。Code surface 完整;只剩 Phase 5 (ii) 真机 acceptance + 0.4.0 tag。

- **状态**:Code 已 land(`fae127d` Phase 2 → `42d048b` Phase 5 (i))。Gates **730 / 730** + typecheck + biome clean。Codex 4 轮 pre-impl plan review + 4 轮 post-impl audit,每 required fix 都已 fold-in commit。
- **下一步**:per [`v2/test-plan-v2g.md`](./v2/test-plan-v2g.md) 跑 8 个真机 scenario;过了 cut **0.4.0** tag(覆盖 `v2-F.0 + v2-G + Poppo HTTP adapter`)。
- **关键 known 技术债**(留至下月触发):
  - **v2-A `source/recipe.ts` Poppo-bake 未抽离** —— 触发条件:接入下个月任意非 Poppo Android 项目;到时启动 v2-H (`SourceProfile` extraction)。设计 lock § Known 技术债 有详。
  - **Q6 redaction policy profile-owned**(v2-G.1 candidate)—— 触发条件:接入第二 source 且其敏感字段名 ≠ Poppo 的。MVP 是 hardcoded list in `poppo_http/redact.ts`。
  - **Agent-facing per-record preview / truncation**(v2-G.1)— ✅ **closed in v0.5.1**
    - **Resolution**:Block B ship 完成。`EvidenceSource.previewForAgent?(record)` 可选钩子;
      runtime page-slice-after 调用 + 注入 `record._meta.preview = {truncated, fullSizeBytes,
      truncatedFields}`;`fullRecords: true` 让 agent 显式付代价(同时 limit 隐式
      cap 至 10,>10 → `query_malformed`)。`poppo_http` 实装:`body.text` /
      `body.decoded` / `request.decoded` 两端三 hotspot 都过 2048 B 阈值后切首 1024 字符。
    - **真机 acceptance**(device 951a20a2 / Poppo `com.baitu.poppo`):50 records 中 7 条
      truncated,fullSize sum 124619 B,saved sum 94678 B = **76% 压缩**。详见 cut commit。
    - **Lock + provenance**:[`v2/preview-for-agent.md`](./v2/preview-for-agent.md),
      codex 4-round lock review + Phase 1-4 各自 audit(STOP×5 → GO,全 amendments fold-in)。
    - **Commit chain**:`72fe1ec` lock → `b4b2a09` Phase 1 → `ac4fcc2` Phase 2 →
      `f5ad1f3` Phase 2 audit fix → `95463d8` Phase 3 → `560d837` Phase 4 →
      `ae071e3` Phase 4 audit fix → v0.5.1 cut。
  - **Block A 软 bypass:`tsMsRange:{from:0}`**(v2-G.1 sub-item)— ✅ **closed in v0.5.1**
    - **Resolution**:与 Block B 同 sprint 同 cut。`PoppoHttpQuerySchema.tsMsRange` 改
      `{from, to}` 双 required + 24h window cap refine;`poppo_http.bindSession` 不再合成
      partial range(只在 tsMsRange 已存在时 clamp `from` floor)。partial range / >24h /
      inverted range 都在 zod parse 阶段被打回 `query_malformed`。
    - **真机 verify**:`{from:0}` 无 `to` → reject,`{from:0,to:25h}` → reject with
      "must be <= 86400s (24h) for poppo_http",`pathPrefix:"/"` 不合成 tsMsRange。

---

## v3(更远期)

### v3-A · App-side debug sidekick(debugImplementation 模块)

- **Motivation**:[`suggestion-chat.md` § "需要一个小型 app-side debug helper"](../suggestion-chat.md) + [§ "androidclaudio 看看这个"](../suggestion-chat.md)。MCP 通过 ADB 拿不到的:`ApplicationExitInfo` 完整字段、当前 ViewModel state summary、当前 NavRoute、业务事件 timeline、OkHttp request 关联。
- **架构形态**:
  ```
  debug APK (debugImplementation only)
    ↓ exposes via localabstract socket
  adb forward tcp:<port> localabstract:<name>
    ↓
  MCP (sidekick adapter)
    ↓
  Agent
  ```
- **关键设计原则(吸收 androidclaudio 教训)**:
  - **不要**扫描 public methods 自动暴露(androidclaudio 模型)
  - 用显式 `DebugProbe` 契约:`id` / `describe()` / `readState()` / `invoke(action, args)`,每个 action 标 `risk: low/medium/high`
  - 默认只读 + write action allowlist
  - 不允许 fallback 到无参构造器伪造 live instance
  - 写入 sidekick 的所有数据先经 `DebugEventLogger.sanitize()`
- **触发条件**:v2-A(source mapping)在生产可用 + 出现"裸 ADB 拿不到这个业务字段"的真实痛点至少 3 次
- **未决问题**:
  - sidekick 的 SDK 形态:三个自有 repo 都接入,跨 repo 共用一个模块还是各自一份?
  - 跨 Poppo(View)与 popposhell(Compose)的契约统一性
  - Security:即便 debug-only,localabstract 也可能被同设备其他 app 读到——是否需要 token-based 握手
- **风险**:androidclaudio 实践证明 DI 解析(Koin / Hilt / Dagger)很难做对——v3 启动前要先做技术 spike

### v3-B · IDE 索引接入(JetBrains MCP / Kotlin PSI / LSP)

- **Motivation**:v2-A 的 `rg` 模糊匹配在大型项目上误匹配率不可接受。
- **触发条件**:v2-A 上线后实测发现 confidence > 0.8 的 source candidate 准确率仍 < 70%
- **未决问题**:绑哪个 IDE / LSP(Kotlin LSP 现状?Android Studio 内部 API?);跨 IDE 兼容性

### v3-C · Crashlytics / App Quality Insights 整合

- **Motivation**:[`suggestion-chat.md` § "Crashlytics / Android Vitals / IDE crash data"](../suggestion-chat.md)。"线上问题回放"场景。
- **触发条件**:出现真实"我想用 MCP 调出某个生产 crash 的最近本地复现 session" 需求
- **未决问题**:Crashlytics API 访问权限、隐私边界

### v3-D · App 端日志诊断回路(绕过 logd 限制)

- **Motivation**:Android `Log.X` 单条 message ~4076 字符上限,长 message 被 logd **静默截断**;MCP 端只能事后启发式标 `truncated_suspect`(见 [`decision-amendments.md` § A](./decision-amendments.md#a--logcat-防御四件套q2-增量))。要拿到完整长日志,必须**绕过 logd**。
- **方案候选**:
  1. **Sidekick channel**(与 v3-A 同根):debugImplementation 模块在 app 进程内开 socket / 写文件,长日志走旁路;MCP 通过 `adb forward` 拉取。
  2. **chunked logging convention**:app 团队约定长日志手动 chunk(`msg.chunked(3000)` + 序号 prefix),MCP parser 识别 prefix 重组。低工程量,但需团队纪律。
  3. **`Log.wtf` escape**:critical 长日志统一用 `Log.wtf`(实际不受同样限制,且会触发 bug report)。最便宜但语义不对(wtf 是"不可能发生"的事)。
- **触发条件**:v1 实测出现 ≥3 次"truncated_suspect 命中导致 debug 无法继续"的真实案例
- **依赖**:与 v3-A sidekick 共用 channel(走方案 1)→ v3-A 是前置
- **未决问题**:跨 Poppo(View)与 popposhell(Compose)的统一 API 形态

---

## v1 内待 spike / 中立未决(源自 codex audit,见 [`audit-2026-05-19-codex.md`](./audit-2026-05-19-codex.md))

这一段不算 backlog,是 v1 实施中**进入相关 Phase 前**必须解决的 spike 问题。中立未决意味着 codex 的建议方向对,但需要真机或工程实测才能定具体形态。

### v1-spike-A · M4 时间字段 trimming

- **codex 建议**:jsonl 每行加 `observedSeq` + `rawLineNo` + `parsedLocalTs` + `sessionYear` + `deviceTimezone?`
- **我方判断**:`observedSeq` + `parsedTs`(已 normalized ISO8601 含年份) + `rawLineNo` 三字段必加;`sessionYear` 与 `deviceTimezone` 一次性写 `metadata.json` 即可,不必每行重复
- **触发**:Phase 4 parser 实现时,先按"3 字段 per-row + metadata 全局 TZ"做;若 fixture 测试或 crash window 计算出现年份/TZ 歧义,再扩字段
- **未决**:跨 buffer 时序(events 与 main 时钟稍微飘)是否需要二次校正
- **进度**:未启动

### v1-spike-B · M5 `input_text` 输入边界

- **codex 建议**:v1 只支持 ASCII printable,unicode reject `unsupported_text_input`
- **我方判断**:popposhell 是中国 app,中文输入是核心场景;直接 reject 太刚
- **v1 拟定方案**:`input_text({ runId, text, mode?: "ascii"|"unicode-via-clipboard", sensitive? })`,default `"ascii"`
  - `ascii` 模式:仅允许 `\x20-\x7E` 范围 + 必要 shell escaping
  - `unicode-via-clipboard` 模式:`am broadcast -a clipper.set --es text "..."` + `input keyevent PASTE`(需设备 API ≥ 24);失败 reject `clipboard_unavailable`
- **触发**:Phase 6 实现 `input_text` 时
- **未决**:`clipper` 这种 broadcast 方案在国产 ROM 上的兼容性(尤其华为/小米);可能要 fallback 到 `adb shell input text` 配合 unicode→Unicode escape 的 `--keep-original` hack
- **进度**:未启动

### v1-spike-C · M6 capture exec-out 路径兼容

- **codex 建议**:`adb exec-out uiautomator dump /dev/tty` 直接落本地,不留设备临时文件
- **我方判断**:方向对,但需要真机 spike 验证 Android 13/14/15 + 国产 ROM(MIUI / EMUI / HarmonyOS)的 `/dev/tty` redirect 支持
- **v1 拟定方案**:优先 `exec-out` + 失败 fallback 到 `/sdcard/Android/data/<package>/cache/android-debug-mcp-<runId>-<captureId>.xml`,完成后 `adb pull` + 设备侧 `rm`
- **触发**:Phase 6 实现 capture 时,先开个 spike branch 跑两台不同设备
- **未决**:某些 ROM 的 selinux 策略可能拒绝写 `Android/data/<pkg>/cache`,需要二次 fallback 到 `/sdcard/Download/` 但要清理
- **进度**:未启动

---

## 持续(ongoing,无特定 milestone)

### redaction policy 拓展

- v1 默认覆盖 `Authorization` / `Cookie` / `token` / `password` / `otp` / `verification` 6 个 key。
- 长期要加:`refreshToken` / `accessToken` / `email` / `phone` / `idCard` / `lat` / `lng` / `deviceId` / `imei` / `imsi`
- v1 实施时若发现某 sensitive 字段在测试数据里漏脱,直接加进 list,不算翻案
- 配置化形态(用户自定义 allowlist / blocklist)留到 v2

### Parser fixture 持续补充

- 每次真机 debug 出现 parser 漏配的格式(threadtime 罕见变体、超长 message、unicode 边角、binary log 误入 main),把样本提到 `tests/fixtures/logcat/`,unit test 加一条
- 不算 backlog 条目,但记在这里提醒纪律

### worker 层 UTF-8 跨 chunk 拆分测试(Phase 12 codex deferred-with-note)

- 派生路径 `LogcatWorker` 的 `TextDecoder(stream:true)` → `LineBuffer` → `parser`:一个 UTF-8 多字节序列被 adb stdout 的 chunk 边界劈开时,只有 worker 层端到端测试能直接锁住。
- 现状:`raw_writer.test.ts` 已测 raw 侧的 byte-split 保真,`line_buffer.test.ts` 测行缓冲;worker 层缺一条「半截 UTF-8 跨 chunk」用例。
- 代码本身用法正确(`TextDecoder` 流式),codex 评审认定非阻塞;v1.1 test-hardening 时补一条 worker 级测试。
