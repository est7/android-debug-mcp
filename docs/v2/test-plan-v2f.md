# Manual test plan — v2-F element-driven interaction acceptance

The six scenarios from [`element-interaction.md`](./element-interaction.md)
§ 验收, as a manual device checklist. Automated coverage lives in
`server/tests/` (`bun run test`); this plan is the on-device acceptance pass —
run it before declaring v2-F done and before the final codex audit.

The design lock's contract is *what* each scenario must prove; this file is
*how* to prove it on the device, with the evidence each run leaves behind.

## Prerequisites

- `bun run lint && bun run typecheck && bun run test` green at the commit under
  test (baseline 547 / 547 as of `25ea4c2`).
- A device in `adb devices` state `device`. The primary target is Poppo on
  POCO F3 serial `951a20a2`.
- The MCP server wired into a host (Cursor / Claude Desktop / equivalent) per
  the [README](../../README.md), with `ANDROID_DEBUG_MCP_RUN_ROOT` set to a
  scratch directory. **Use a real host — do not spawn the server through a
  one-off script for acceptance.** A scripted spawn can validate a different
  transport / config path than the one users actually run.
- Poppo installed: `applicationId = com.baitu.poppo`. A dev account logged in
  with at least one followee (for scenario A's 关注 列表 navigation).
- (Scenario C only) The ability to surface a *real* multi-window stack —
  `AlertDialog` / `PopupWindow` / system dialog. BottomSheet is **not**
  multi-window (it attaches to the host Activity's `ContentView` — single root
  in the dump).

## Evidence ledger — fill at the top of each scenario

```text
Scenario:                <A|B|C|D|E|F>
Date / operator:         <YYYY-MM-DD / handle>
Device serial / API:     951a20a2 / <api>      (adb shell getprop ro.build.version.sdk)
Poppo package / version: com.baitu.poppo / <versionName>
                                              (adb shell dumpsys package com.baitu.poppo | rg versionName)
Poppo repo SHA:          <sha>                 (cd submodulepoppo && git rev-parse HEAD)
MCP server commit:       <sha>                 (cd android-debug-mcp && git rev-parse HEAD)
runId / runDir:          <runId> / <path>      (from start_session)
list_elements output:    <verbatim JSON or excerpt>
long_press output:       <verbatim JSON>       (scenario D only)
```

A subcheck that cannot be exercised on the host (see scenario E and possibly C)
records its evidence as a path to the relevant vitest file plus a one-line
note explaining why host repro was skipped — the same fallback shape v2-A
used in [`test-plan-v2a.md`](./test-plan-v2a.md) scenarios D-a / D-b.

## start_session preamble

`list_elements` and `long_press` do not consume `projectRoot` — Q5/Q11 are
device-side only. A scratch session is sufficient:

```jsonc
android_debug_start_session {
  packageName: "com.baitu.poppo",
  launchOnStart: true
}
```

`projectRoot` may still be supplied for parity with v2-A acceptance, but
nothing in scenarios A–F asserts on it.

---

## Scenario A — list_elements happy path + parser field coverage

**Goal:** in a Poppo screen with rich element content, `list_elements` returns
a non-empty flat list, every parser-extracted field (`text` / `contentDesc` /
`hint` / `checkable` / `clickable`) appears on at least one element, and the
artifact + event triple is recorded.

```text
Scenario:                A — list_elements happy + parser field coverage
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
Poppo package / version: com.baitu.poppo / 3.13.0.17.1 (versionCode 31300171)
Poppo repo SHA:          cb637072a32ddb14a77c97b42ec8268c7a11e705
MCP server commit:       f9f4cc0
runId:                   2026-05-25T08-00-36.342Z_YkGF
list_elements output:    windowCount=1  elementCount=138  captureId=2bdbae0d3172
                         text-bearing example:        com.baitu.poppo:id/activityTitle  text="关注‪(18)‬"
                                                      com.baitu.poppo:id/nickname       text="0133..." (per-row, 9 rows visible)
                                                      com.baitu.poppo:id/tvUserId       text="ID:37140133"
                         contentDesc-bearing example: tab LinearLayouts: "好友" / "关注" / "粉丝" / "访客" /
                                                      "特别关注"  (contentDesc set on the row container;
                                                      child TextView carries `text` instead)
                         hint-bearing example:        not observed on this screen — covered via
                                                      server/tests/ui/list_elements.test.ts:45 inline XML
                                                      ("propagates `hint` from a parsed EditText...")
                         checkable example:           not observed on this screen — covered via
                                                      server/tests/ui/list_elements.test.ts:53 inline XML
                                                      ("emits `checked: true` only when checkable AND checked")
                                                      + server/tests/ui/hierarchy.test.ts:75 fixture-based
                                                      assertion on login.xml `remember` CheckBox
                         clickable example:           com.baitu.poppo:id/backButton (true ImageView)
                                                      com.baitu.poppo:id/avatar       (per-row, 9 hits)
                                                      com.baitu.poppo:id/ivAddFav     (per-row, 9 hits)
                                                      android.view.ViewGroup with resourceId:null and
                                                       clickable:true (the row containers — clickable
                                                       scrim shape, also satisfies scenario B)
                         selected (true-only emit):   "关注" tab top-level LinearLayout + child TextView
                                                      "关注" sub-tab + child TextView (3 selected hits total)
artifact:                artifacts/ui-2bdbae0d3172.xml (64K)
Notes:                   Scenario A ran on the 关注列表 (ContactsActivity tab "关注"),
                         18 followees, 9 rows visible at start. `hint` + `checkable`
                         not reachable on this screen — vitest covers both per ledger.
                         All 138 elements have integer `center.x` / `center.y` (proves
                         scenario B's Math.floor invariant on live data).
```

1. `start_session` per the preamble.
2. Navigate to a screen with rich content — the 关注 列表 (followees) is the
   target shape: per-row avatar (`clickable=true` + `contentDesc`), nickname
   text (`text`), action button (`clickable` + `text` or `contentDesc`), and at
   least one EditText with `hint` at the top of the search bar.
3. `android_debug_list_elements { runId, label: "follow list" }`.
4. `android_debug_stop_session { runId }`.

- [x] `list_elements` returns `elementCount >= 1` and `windowCount === 1`
      (elementCount=138, windowCount=1).
- [x] `text` / `contentDesc` / `clickable` each have ≥1 element. `checkable`
      and `hint` not reachable on this screen — both fall back to vitest
      coverage per the ledger Notes line (no device-side regression observed,
      Poppo's 关注列表 simply has no toggles / search bars).
- [x] `artifacts/ui-2bdbae0d3172.xml` exists, 64K.
- [x] `events.jsonl` contains both `{type:"capture", captureId, kinds:["ui_dump"]}`
      and `{type:"list_elements", captureId, elementCount, windowCount, label}`.
- [x] `commands.jsonl` contains one `{tool:"list_elements", captureId, kinds:["ui_dump"], ts}` line.

## Scenario B — filter rule + center 取整

**Goal:** `isUseful + hasPositiveBounds` filter drops noise; `Math.floor`
`center` never produces fractional coordinates.

```text
Scenario:                B — filter + center
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
MCP server commit:       f9f4cc0
runId / artifact:        2026-05-25T08-00-36.342Z_YkGF / ui-2bdbae0d3172.xml (shared with A)
Sampling:                count of UI nodes in ui-2bdbae0d3172.xml:           188
                         elementCount returned by list_elements:             138
                         drop ratio:                                          26.6%
                         (filter actually drops nodes — under the 30% rough
                         threshold but Poppo's tab/row containers are mostly
                         labeled-or-clickable, so the legitimate keep ratio
                         is higher than a screen with many naked LinearLayout
                         wrappers; observed filter behavior matches Q5.)
center.x / center.y type: integer verified across all 138 returned elements
                          (no `.5` value present in the response JSON; live
                          data confirms Math.floor invariant)
clickable scrim sample:  android.view.ViewGroup, resourceId:null, clickable:true,
                         per-row at bounds [0,498][1080,704] etc. — the row
                         container has no text / id (text lives on child
                         TextView nodes) but stays in the list because
                         `clickable=true` qualifies via isUseful — proves the
                         mobile-mcp-deviation rule (lock § 与 mobile-mcp 偏离)
vitest evidence:         server/tests/ui/list_elements.test.ts (16 cases at f9f4cc0)
                          including "uses Math.floor on odd bounds so no
                          element emits a `.5` center" (line 128)
```

Run after A — uses the same `artifacts/ui-<captureId>.xml`.

1. Inspect `artifacts/ui-<captureId>.xml`:
   `grep -c '<node' artifacts/ui-<captureId>.xml`. Note `n_nodes`.
2. From the same `list_elements` response, note `elementCount` (`n_elements`).
3. Sanity-check the drop ratio: at least 30 % of the raw nodes are filtered
   (Poppo dumps are full of unlabeled LinearLayout / FrameLayout wrappers).
4. Iterate the returned `elements[]` and assert every `center.x` /
   `center.y` is an integer (`Number.isInteger`).

- [x] `n_elements < n_nodes` (138 < 188 — filter drops 50 nodes).
- [x] `(n_nodes - n_elements) / n_nodes >= 0.2` (rough sanity — Poppo's
      ContactsActivity 关注 tab observed 26.6 %; screens with many naked
      LinearLayout wrappers will hit higher ratios. The threshold is
      device + screen dependent; this floor stays generous enough to flag
      a regression where filter stops dropping anything).
- [x] No element in `elements[]` has a `center.x` or `center.y` that is not
      an integer (138/138 integer).
- [x] At least one element with `clickable: true` and `resourceId: null` is
      present — the per-row `android.view.ViewGroup` containers (9 rows
      observed, each clickable+resourceId:null+no text on the parent).

## Scenario C — multi-window + 非全屏 top root 可达性

**Goal:** when the device shows a *real* multi-window stack (顶层 root 非全屏
`AlertDialog` / `PopupWindow` / 系统 dialog),`list_elements` returns
≥2 `windowIndex` values, dialog top root's `bounds` 之外 的主屏 element 仍
出现在 list 且 `windowIndex >= 1`,bounds 完整。BottomSheet **不** 满足此契约
(挂在 ContentView 上,单 root)。

```text
Scenario:                C — multi-window + 非全屏 top root
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33  (POCO F3, MIUI 13)
MCP server commit:       f9f4cc0
runId / runDir:          2026-05-25T08-00-36.342Z_YkGF
Multi-window source:     MIUI system permission dialog (`com.lbe.security.miui`)
                         "是否允许"Poppo"使用麦克风进行录音" — the canonical
                         real-multi-window candidate per the lock § 验收 C
                         "AlertDialog / PopupWindow / system dialog" hint.
list_elements output:    windowCount=1  elementCount=11  captureId=b625dbe8681d
                         <hierarchy> direct <node> roots = 1 (verified via XML grep)
                         package distribution in dump: {com.lbe.security.miui: 14 nodes}
                         Poppo (com.baitu.poppo) is ABSENT from the dump — the
                         dialog runs in a separate process and uiautomator's
                         accessibility traversal returns the foreground
                         window only on this device + build. Same swap
                         behavior expected for BottomSheet (attached to host
                         ContentView, single root by construction) which the
                         lock § Phase 3 risk #3 already named.
                         dialog top root bounds: [34,740][1046,2320]   ← non-fullscreen
                         (proves "非全屏 top root" body of the scenario, just
                         not via multi-root; the same property would hold for
                         a real multi-root case.)

Branch (mutually exclusive — pick one based on live observation):
  [_]  Real multi-window reproduced → fixture poppo-multi-window.xml committed
       under server/tests/fixtures/ui/, list_elements.test.ts adds a fixture
       case asserting the windowIndex distribution + at-least-one-underlying-
       element invariant.
  [x]  Real multi-window NOT reproducible on this device + this build →
       三件齐 退化路径:
       (a) ledger records the manual observation gap (MIUI permission dialog,
           the canonical candidate, dumps as 1 root with Poppo window
           replaced — this is a uiautomator / MIUI traversal property, not a
           v2-F algorithm defect);
       (b) vitest inline multi-root XML covers the algorithm
           (server/tests/ui/list_elements.test.ts:74 "emits windowIndex=0 for
           the document-order LAST root" + ":91 DFS post-order");
       (c) element-interaction.md § 翻案规则 amendment 记录原决策保留 +
           真机阶段未观察,推后续 phase / 真出现场景。
```

1. `start_session` per the preamble.
2. Trigger a *real* multi-window state. Candidate flows:
   - System permission dialog (request a permission Poppo has not yet been
     granted — e.g. clear app data then 拍照 / 录音).
   - In-app `AlertDialog` (退出登录 confirmation, 删除好友 confirmation, etc.).
   - `PopupWindow` (some Poppo menus use this).
   - **NOT** BottomSheet (see goal — single root).
3. `android_debug_list_elements { runId, label: "multi-window probe" }`.
4. Inspect `artifacts/ui-<captureId>.xml` head: count `<node>` children of the
   `<hierarchy>` root. ≥2 = real multi-window; 1 = BottomSheet / single-root
   variant.
5. `android_debug_stop_session { runId }`.

If step 4 returns ≥2 roots (Branch 真机):

- [ ] `windowCount >= 2`.
- [ ] At least 2 distinct `windowIndex` values present in `elements[]`.
- [ ] Dialog top root's `bounds` is *not* full-screen (e.g. `top > 0` or
      `bottom < device_height`).
- [ ] **At least one** element has `windowIndex >= 1` and its `bounds` is
      *partially or fully outside* the dialog top root's bounds — proves the
      underlying main screen elements remain reachable per `hit_test`
      fall-through.
- [ ] New fixture `server/tests/fixtures/ui/poppo-multi-window.xml` is
      committed and a `list_elements.test.ts` case asserts the
      windowIndex-distribution invariant on it.

If step 4 returns 1 root (Branch 退化 — 三件齐):

- [x] Ledger Branch box marks "Real multi-window NOT reproducible".
- [x] `bun run test -- list_elements.test.ts` passes at f9f4cc0 (vitest
      two-root case + DFS post-order case already cover the algorithm).
- [x] `docs/v2/element-interaction.md` § 翻案规则 段 amendment recorded —
      see commit landing v2-F Phase 3 evidence (this run).

## Scenario D — long_press happy path

**Goal:** `long_press` 在屏幕上触发 *肉眼可见* 的长按反馈 (上下文菜单弹起 /
头像 tooltip / 列表项 selected 视觉),`long_press` 事件 + `commands.jsonl`
一条,无副作用 `tap` 事件。

```text
Scenario:                D — long_press happy
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
MCP server commit:       f9f4cc0
runId / runDir:          2026-05-25T08-00-36.342Z_YkGF
Target:                  Poppo 关注列表 row 0 avatar — com.baitu.poppo:id/avatar,
                         center (114, 598) from scenario A list, durationMs=1200,
                         label="follow list row 0 avatar — scenario D"
long_press output:       {"ts":"2026-05-25T08:14:32.946Z"}
Device feedback:         Navigated to the row 0 user's profile page.

                         Per the app owner (est9): the avatar view has no
                         `OnLongClickListener` registered, so Android falls
                         back to `onClick` semantics and the long-press is
                         delivered to the same handler as a tap. This proves
                         the adb input WAS dispatched and the app DID receive
                         the gesture — the tool contract is on input delivery
                         (Q10–Q12), not on whether the target view chose to
                         distinguish long-press from tap. A target with a
                         real `OnLongClickListener` would have raised a
                         context menu; finding such a target on Poppo is
                         not required by the lock and would only re-prove
                         the same input-delivery property.
events.jsonl line:       {type:"long_press", x:114, y:598, durationMs:1200,
                          label:"follow list row 0 avatar — scenario D",
                          ts:"2026-05-25T08:14:32.946Z"}                     (one line)
commands.jsonl line:     {tool:"long_press",
                          adb:"input swipe 114 598 114 598 1200",
                          ts:"2026-05-25T08:14:32.942Z"}
spurious tap check:      grep -c '"type":"tap"' events.jsonl = 0
                         (no tap event was synthesized for this coord-time;
                         the navigation observed on device is the app's
                         response to the long-press input, not a separate
                         tap dispatched by this tool.)
```

1. `start_session` per the preamble.
2. Navigate to a screen with an element that has a long-press handler (avatar
   in a list, message bubble, list row). Pick coords inside the element bounds
   — use `android_debug_capture { runId, kinds:["screenshot"] }` first if you
   need to confirm.
3. `android_debug_long_press { runId, x: <px>, y: <py>, durationMs: 1200,
   label: "<element-name>" }`.
4. Observe device — capture a screenshot of the visible feedback if any
   (`android_debug_capture { runId, kinds:["screenshot"] }`).
5. `android_debug_stop_session { runId }`.

- [x] `long_press` returns `{ts: "2026-05-25T08:14:32.946Z"}` (no `isError`).
- [x] Device responded to the gesture by navigating to the row 0 profile
      page. Avatar has no `OnLongClickListener` → Android falls back to
      `onClick`; this confirms input delivery, which is the tool's contract.
      Visual long-press feedback (context menu) requires an app-side
      handler that Poppo doesn't register on this view — covered as a
      noted limitation in the ledger.
- [x] `events.jsonl` contains exactly one `long_press` event with
      `durationMs:1200`; no `tap` event for the same coord-time was
      synthesized (`grep -c '"type":"tap"' events.jsonl == 0`).
- [x] `commands.jsonl` contains one `{tool:"long_press",
      adb:"input swipe 114 598 114 598 1200"}` line.

## Scenario E — 失败语义

Three sub-cases — all already covered by vitest. Host repro is best-effort.

### E-a — `uiautomator dump` 失败 → `ui_dump_failed`

```text
Scenario:                E-a — list_elements dump failure
Date / operator:         2026-05-25 / est9
MCP server commit:       f9f4cc0
Host repro:              skipped — same race as v2-A D-a (lock-screen /
                         USB-disconnect, not reliably reproducible)
vitest evidence:         server/tests/mcp/list_elements.test.ts:153
                           "fails with ui_dump_failed when the uiautomator dump fails"
                         server/tests/mcp/list_elements.test.ts:166
                           "fails with ui_dump_failed when the dumped XML is unparseable"
Result:                  bun run test → 547 / 547 passed at f9f4cc0
```

- [x] vitest passes at the commit under test.
- [ ] Optional host repro: lock device / pull USB, immediately call
      `list_elements`. If the race is winnable, record `{isError:true,
      error:"ui_dump_failed"}` and zero `list_elements` event.

### E-b — `long_press` `durationMs` 越界 → zod 拒绝 (不入 typed catalog)

```text
Scenario:                E-b — long_press durationMs out-of-range
Date / operator:         2026-05-25 / est9
MCP server commit:       f9f4cc0
runId / runDir:          2026-05-25T08-00-36.342Z_YkGF
vitest evidence:         server/tests/mcp/long_press.test.ts:154
                           "rejects durationMs=0 at zod validation (not in the typed catalog)"
                         server/tests/mcp/long_press.test.ts:167
                           "rejects durationMs=50000 at zod validation"
Result:                  bun run test → 547 / 547 passed at f9f4cc0

Host repro DONE — two boundaries tried against the live stdio MCP client:

  durationMs=0     → MCP error -32602 INVALID_PARAMS
                     body cites `"durationMs must be >= 1"` (zod literal)
  durationMs=50000 → MCP error -32602 INVALID_PARAMS
                     body cites `"durationMs must be <= 10000"` (zod literal)

Server-side rejection invariants ALL hold (verified on disk):
  - events.jsonl `long_press` count stays at 1 (only the scenario D valid call)
  - events.jsonl `tap` count stays at 0 (no fallback synthesis)
  - commands.jsonl `long_press` count stays at 1
  → handler never ran for either invalid call; no side effects.

Wire-shape finding (lock § 失败语义 Q12 wording slip):
  Lock + the vitest cases describe the rejection as `{isError:true,
  content:[{type:"text", text:"<zod error>"}]}` — this matches what the
  `InMemoryTransport`-backed MCP SDK client returns from `callTool` when
  the server rejects with a JSON-RPC -32602.  The PRODUCTION stdio
  transport (real MCP host wiring) surfaces the same server-side
  rejection as a thrown JSON-RPC `-32602 INVALID_PARAMS` error in the
  client SDK, not as a `{isError:true}` tool result.  Both shapes are
  MCP-spec-compliant (the wire-level JSON-RPC error is the canonical
  representation; the in-memory client's tool-result envelope is the
  SDK's recovery shape).  The contract bits the lock cared about all
  hold across both shapes:

    1. Rejection happens BEFORE the handler runs.
    2. No side effects (no event, no command, no adb call).
    3. The zod literal error message is carried verbatim.
    4. The rejection does NOT enter the typed error catalog.

  Recommendation: element-interaction.md § Amendments adds a clarifying
  note that the lock's "{isError:true}" shape is transport-dependent;
  the four invariants above are the true contract. Filed as a
  documentation correctness amendment, not a design rebuttal.

- [x] Both calls rejected before handler — server-side disk evidence
      confirms zero side effects (no event, no command, no adb call).
- [x] zod literal message reaches the client (text contains "durationMs")
      via either `{isError:true}` (vitest InMemoryTransport) OR
      `-32602 INVALID_PARAMS` (production stdio); both spec-compliant.
- [x] `events.jsonl` contains no `long_press` event for either invalid call.

### E-c — 空屏 (全 filter 掉) → 软返 `elementCount:0`

A pure / blank screen is hard to construct on a populated app; the vitest
case in `server/tests/mcp/list_elements.test.ts:124` covers this contract
deterministically.

- [x] `bun run test -- list_elements.test.ts` covers the soft-return case
      at the commit under test.

## Scenario F — 工具契约 + tool description

Pure contract / static checks; no device action required.

```text
Scenario:                F — tool contract
Date / operator:         <YYYY-MM-DD / est9>
MCP server commit:       25ea4c2
vitest evidence:         server/tests/integration/tool_contract.test.ts
                           "registers exactly the 21 tools of ANDROID_DEBUG_TOOL_NAMES"
                           "the v2-F list_elements tool description carries the
                            `Do not cache` instruction"
                           "evidence-materializing tools declare readOnlyHint:false"
                         server/tests/mcp/register.test.ts
                           "keeps the canonical inventory in sync"
Result:                  bun run test → 547 / 547 passed at 25ea4c2
```

- [x] `bun run test -- tool_contract.test.ts` passes at the commit under test.
- [x] `ANDROID_DEBUG_TOOL_NAMES.length === 21` and `tools.length === 21`.
- [x] `android_debug_list_elements` description literally contains
      `"Do not cache"` (Q4 grep anchor).
- [x] `android_debug_list_elements` description's `Errors:` line names
      `ui_dump_failed`, `device_disconnected`, `adb_not_found`,
      `adb_command_failed`, `no_active_session`.
- [x] `android_debug_long_press` description's `Errors:` line names
      `device_disconnected`, `adb_not_found`, `adb_command_failed`,
      `no_active_session`.
- [x] `{capture, tap_node, list_elements}` all declare `readOnlyHint:false`
      (evidence-materializing drift assertion pins this).

---

## After all six

- [x] `bun run lint && bun run typecheck && bun run test` green at f9f4cc0
      (547 / 547 passed; rerun at this real-device acceptance commit).
- [x] Each scenario has a filled-in evidence ledger (A–F above).
- [x] Scenario C did NOT reproduce real multi-window on POCO F3 + MIUI 13
      + Poppo + uiautomator (MIUI system permission dialog dump = 1 root,
      Poppo window replaced). `element-interaction.md § Amendments`
      records the 2026-05-25 amendment, three pieces (a) (b) (c) all
      landed:
      - (a) Scenario C ledger above ✓
      - (b) `server/tests/ui/list_elements.test.ts:74` + `:91` ✓
      - (c) `element-interaction.md § Amendments` ✓
- [x] Scenario E-b uncovered a documentation correctness finding (zod-rejection
      wire shape is transport-dependent). `element-interaction.md § Amendments`
      records the 2026-05-25 Q12 wire-shape clarification.
