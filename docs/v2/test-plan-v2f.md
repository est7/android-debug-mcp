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
Date / operator:         <YYYY-MM-DD / est9>
Device serial / API:     951a20a2 / <api>
Poppo package / version: com.baitu.poppo / <versionName>
Poppo repo SHA:          <sha>
MCP server commit:       25ea4c2
runId / runDir:          <runId>
list_elements output:    windowCount=<n>  elementCount=<n>  captureId=<id>
                         text-bearing example:        <resourceId>  text="..."
                         contentDesc-bearing example: <resourceId>  contentDesc="..."
                         hint-bearing example:        <resourceId>  hint="..."
                         checkable example:           <resourceId>
                         clickable example:           <resourceId>
artifact:                artifacts/ui-<captureId>.xml (<size>K)
Notes:                   <if hint not observed live, mark "hint covered via
                         server/tests/ui/list_elements.test.ts:45 inline XML">
```

1. `start_session` per the preamble.
2. Navigate to a screen with rich content — the 关注 列表 (followees) is the
   target shape: per-row avatar (`clickable=true` + `contentDesc`), nickname
   text (`text`), action button (`clickable` + `text` or `contentDesc`), and at
   least one EditText with `hint` at the top of the search bar.
3. `android_debug_list_elements { runId, label: "follow list" }`.
4. `android_debug_stop_session { runId }`.

- [ ] `list_elements` returns `elementCount >= 1` and `windowCount === 1`
      (single-root happy path).
- [ ] **At least one** element each has: `text !== null && text !== ""`,
      `contentDesc !== null && contentDesc !== ""`, `clickable: true`,
      `checkable: true` (if no `checkable` element on this screen, navigate to
      one with a switch — Me-tab → 设置 → any toggle).
- [ ] If a `hint`-bearing EditText is reachable, **at least one** element has
      `hint !== null && hint !== ""`; otherwise record the vitest fallback per
      the ledger Notes line.
- [ ] `artifacts/ui-<captureId>.xml` exists and is non-empty.
- [ ] `events.jsonl` contains both `{type:"capture", captureId, kinds:["ui_dump"]}`
      and `{type:"list_elements", captureId, elementCount, windowCount, label}`.
- [ ] `commands.jsonl` contains one `{tool:"list_elements", captureId, kinds:["ui_dump"], ts}` line.

## Scenario B — filter rule + center 取整

**Goal:** `isUseful + hasPositiveBounds` filter drops noise; `Math.floor`
`center` never produces fractional coordinates.

```text
Scenario:                B — filter + center
Date / operator:         <YYYY-MM-DD / est9>
Device serial / API:     951a20a2 / <api>
MCP server commit:       25ea4c2
runId / runDir:          <runId> (may share with A)
Sampling:                count of UI nodes in artifacts/ui-<captureId>.xml: <n_nodes>
                         elementCount returned by list_elements:           <n_elements>
                         drop ratio:                                       <n_nodes - n_elements> / <n_nodes>
center.x / center.y type: int verified across all returned elements
                          (no `.5` value present in JSON)
vitest evidence:         server/tests/ui/list_elements.test.ts (15 cases at 5e9560e)
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

- [ ] `n_elements < n_nodes` (filter actually drops nodes).
- [ ] `(n_nodes - n_elements) / n_nodes >= 0.3` (rough sanity; tune the
      threshold per device — Poppo dumps reliably hit >50 % drop).
- [ ] No element in `elements[]` has a `center.x` or `center.y` that is not
      an integer.
- [ ] At least one element with `clickable: true` and `resourceId: null` is
      present (proves clickable scrim / wrapper is kept by the
      mobile-mcp-deviation rule). If none on this screen, mark `recorded via
      server/tests/ui/list_elements.test.ts:119 inline XML`.

## Scenario C — multi-window + 非全屏 top root 可达性

**Goal:** when the device shows a *real* multi-window stack (顶层 root 非全屏
`AlertDialog` / `PopupWindow` / 系统 dialog),`list_elements` returns
≥2 `windowIndex` values, dialog top root's `bounds` 之外 的主屏 element 仍
出现在 list 且 `windowIndex >= 1`,bounds 完整。BottomSheet **不** 满足此契约
(挂在 ContentView 上,单 root)。

```text
Scenario:                C — multi-window + 非全屏 top root
Date / operator:         <YYYY-MM-DD / est9>
Device serial / API:     951a20a2 / <api>
MCP server commit:       25ea4c2
runId / runDir:          <runId>
Multi-window source:     <one of: AlertDialog / PopupWindow / system permission dialog / ...>
list_elements output:    windowCount=<n>  elementCount=<n>  captureId=<id>
                         windowIndex distribution:  {0: <count>, 1: <count>, ...}
                         dialog top root bounds:    [<left>,<top>][<right>,<bottom>]
                         underlying main screen example element (windowIndex >= 1):
                           <resourceId>  bounds=[<l>,<t>][<r>,<b>]
                           — bounds (partially) outside dialog rect: <yes/no>

Branch (mutually exclusive — pick one based on live observation):
  [_]  Real multi-window reproduced → fixture poppo-multi-window.xml committed
       under server/tests/fixtures/ui/, list_elements.test.ts adds a fixture
       case asserting the windowIndex distribution + at-least-one-underlying-
       element invariant.
  [_]  Real multi-window NOT reproducible on this device + this build →
       三件齐 退化路径:
       (a) ledger records the manual observation gap;
       (b) vitest inline multi-root XML covers the algorithm
           (server/tests/ui/list_elements.test.ts:74 "emits windowIndex=0 for
           the document-order LAST root");
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

- [ ] Ledger Branch box marks "Real multi-window NOT reproducible".
- [ ] `bun run test -- list_elements.test.ts` passes at the commit under test
      (vitest two-root case already covers the algorithm).
- [ ] `docs/v2/element-interaction.md` § 翻案规则 段 added an amendment block
      recording: 原决策保留 (`windowIndex===0` 不等于唯一可达;低层 element
      在顶层 bounds 之外仍可达) + 真机 v2-F.0 阶段未观察到 Poppo multi-window
      形态 + 算法由合成 fixture 兜底 + 真机 multi-window 观察推后续 phase /
      真出现场景。

## Scenario D — long_press happy path

**Goal:** `long_press` 在屏幕上触发 *肉眼可见* 的长按反馈 (上下文菜单弹起 /
头像 tooltip / 列表项 selected 视觉),`long_press` 事件 + `commands.jsonl`
一条,无副作用 `tap` 事件。

```text
Scenario:                D — long_press happy
Date / operator:         <YYYY-MM-DD / est9>
Device serial / API:     951a20a2 / <api>
MCP server commit:       25ea4c2
runId / runDir:          <runId>
Target:                  <screen + element + (x,y) coord>
                         (例:关注列表 row 0 avatar, x=120, y=440, durationMs=1200)
long_press output:       {ts: "<iso>"}
Device feedback:         <one of:
                          context menu opened with options [...] /
                          tooltip displayed / row visually selected /
                          no visible feedback (record evidence: screenshot path)>
events.jsonl line:       {type:"long_press", x, y, durationMs, label?}  (一条)
commands.jsonl line:     {tool:"long_press", adb:"input swipe x y x y durationMs"}
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

- [ ] `long_press` returns `{ts: <iso>}` and `isError` is absent / false.
- [ ] Device shows long-press feedback (record what — context menu / tooltip /
      visual select / screenshot path if no menu).
- [ ] `events.jsonl` contains **exactly one** `long_press` event with the
      passed `durationMs`; **no** `tap` event for the same coord-time was
      synthesized.
- [ ] `commands.jsonl` contains one `{tool:"long_press", adb:"input swipe x y
      x y durationMs"}` line.

If the device shows no visible feedback (some long-press handlers do nothing
in the current app state — e.g. a row with no context menu), record this in
the ledger and either retry on a different element OR cite the vitest evidence
`server/tests/mcp/long_press.test.ts` happy-path case as fallback for the tool
contract (the device-feedback subcheck remains best-effort host repro).

## Scenario E — 失败语义

Three sub-cases — all already covered by vitest. Host repro is best-effort.

### E-a — `uiautomator dump` 失败 → `ui_dump_failed`

```text
Scenario:                E-a — list_elements dump failure
Date / operator:         <YYYY-MM-DD / est9>
MCP server commit:       25ea4c2
Host repro:              skipped — same race as v2-A D-a (lock-screen /
                         USB-disconnect, not reliably reproducible)
vitest evidence:         server/tests/mcp/list_elements.test.ts:153
                           "fails with ui_dump_failed when the uiautomator dump fails"
                         server/tests/mcp/list_elements.test.ts:166
                           "fails with ui_dump_failed when the dumped XML is unparseable"
Result:                  bun run test -- list_elements.test.ts → all pass at <commit>
```

- [x] vitest passes at the commit under test.
- [ ] Optional host repro: lock device / pull USB, immediately call
      `list_elements`. If the race is winnable, record `{isError:true,
      error:"ui_dump_failed"}` and zero `list_elements` event.

### E-b — `long_press` `durationMs` 越界 → zod 拒绝 (不入 typed catalog)

```text
Scenario:                E-b — long_press durationMs out-of-range
Date / operator:         <YYYY-MM-DD / est9>
MCP server commit:       25ea4c2
vitest evidence:         server/tests/mcp/long_press.test.ts:154
                           "rejects durationMs=0 at zod validation (not in the typed catalog)"
                         server/tests/mcp/long_press.test.ts:167
                           "rejects durationMs=50000 at zod validation"
Result:                  bun run test -- long_press.test.ts → all pass at <commit>
```

Optional host repro:

1. `start_session`.
2. `android_debug_long_press { runId, x:1, y:1, durationMs: 0 }`.
3. `android_debug_long_press { runId, x:1, y:1, durationMs: 50000 }`.

- [ ] Both calls return `{isError: true}` with the zod range message in
      `content[0].text`; no `{error: "..."}` JSON catalog payload.
- [ ] `events.jsonl` contains **no** `long_press` event for either call.

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

- [ ] `bun run lint && bun run typecheck && bun run test` still green at the
      commit being audited.
- [ ] Each scenario has a filled-in evidence ledger committed (or pasted into
      the audit message — final form is the auditor's call).
- [ ] If scenario C reproduced real multi-window: new fixture
      `poppo-multi-window.xml` committed + `list_elements.test.ts` case added.
- [ ] If scenario C did NOT reproduce: `element-interaction.md` § 翻案规则
      段记录 amendment (三件齐 已落 (a)(b)(c) 中的 (c))。
