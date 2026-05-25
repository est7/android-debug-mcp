# Manual test plan — v2-A tap-to-source acceptance

The five scenarios from [`source-mapping.md`](./source-mapping.md) § 验收, as a
manual device checklist. Automated coverage lives in `server/tests/`
(`bun run test`); this plan is the on-device acceptance pass — run it before
declaring v2-A done and before the final codex audit.

The design lock's contract is *what* each scenario must prove; this file is
*how* to prove it on the device, with the evidence each run leaves behind.

## Prerequisites

- `bun run lint && bun run typecheck && bun run test` green at the commit
  under test (baseline 506 / 506 as of `d50b695`).
- A device in `adb devices` state `device`. The primary target is Poppo on
  POCO F3 serial `951a20a2`.
- The MCP server wired into a host (Cursor / Claude Desktop / equivalent) per
  the [README](../../README.md), with `ANDROID_DEBUG_MCP_RUN_ROOT` set to a
  scratch directory. **Use a real host — do not spawn the server through a
  one-off script for acceptance.** A scripted spawn can validate a different
  transport / config path than the one users actually run.
- Poppo installed: `applicationId = com.baitu.poppo`. A dev account with at
  least one followee (scenario E).
- Poppo source checkout reachable on the host filesystem,
  conventionally `/Users/est9/AndroidStudioProjects/submodulepoppo`.
- `rg` resolvable on the server's `PATH` (`rg --version` succeeds; the server's
  `runRg` resolves via `RG_PATH` env or `which rg`).

## Evidence ledger — fill at the top of each scenario

```text
Scenario:                <A|B|C|D|E>
Date / operator:         <YYYY-MM-DD / handle>
Device serial / API:     951a20a2 / <api>      (adb shell getprop ro.build.version.sdk)
Poppo package / version: com.baitu.poppo / <versionName>
                                              (adb shell dumpsys package com.baitu.poppo | rg versionName)
Poppo repo SHA:          <sha>                 (cd submodulepoppo && git rev-parse HEAD)
MCP server commit:       <sha>                 (cd android-debug-mcp && git rev-parse HEAD)
runId / runDir:          <runId> / <path>      (from start_session)
tap_node output:         <verbatim JSON>
map output:              <verbatim JSON>
```

A subcheck that cannot be exercised on the host (see scenario D) records its
evidence as a path to the relevant vitest file plus a one-line note explaining
why host repro was skipped.

## projectRoot discipline

Every scenario that exercises source mapping (A / C / D-b / E) MUST call
`start_session` with an explicit `projectRoot`. Q5 in the design lock is that
the source root is only the explicit `projectRoot`; the server's `cwd`
fallback is a convenience path, not acceptance proof. Use:

```jsonc
android_debug_start_session {
  packageName: "com.baitu.poppo",
  launchOnStart: true,
  projectRoot: "/Users/est9/AndroidStudioProjects/submodulepoppo"
}
```

Acceptance does not pass if `metadata.projectRoot` in the recorded run is
`null` for any of A / C / D-b / E.

---

## Scenario A — happy path

**Goal:** a tap on a button with an app-package `resource-id` maps to the
right Activity / Fragment with `confidence: "high"` and a code reference inside
the resolved screen owner.

```text
Scenario:                A — happy path
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
Poppo package / version: com.baitu.poppo / 3.13.0.17.1 (versionCode 31300171)
Poppo repo SHA:          f9fc1099b6d9adbb77afa21ede26d2d77d26ad5b
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
runId / runDir:          2026-05-25T03-35-21.378Z_Ui2F
                         /Users/est9/AndroidStudioProjects/submodulepoppo/.android-debug-runs/com.baitu.poppo/u0/2026-05-25T03-35-21.378Z_Ui2F
Target:                  tv_nickname (nickname row) in EditProfileActivity
                         (BaseBindingActivity<ActivityEditProfileBinding>)
                         x=540 y=1619
tap_node output:         anchorNode = com.baitu.poppo:id/tv_nickname (TextView)
                         anchorSource = "tapped_node"
                         preTapForegroundActivity = com.baitu.poppo/...editprofile.EditProfileActivity
                         preTapCaptureId = 7f38826a81d2 → artifacts/ui-7f38826a81d2.xml (26K)
map output:              confidence = "high"
                         signals = [resource_id_present, resource_package_matches_session,
                                    layout_declares_id, layout_inflated_by_foreground_activity,
                                    code_refs_found]
                         resolved screen_owner = .../EditProfileActivity.kt:50
                         matching code_ref = .../EditProfileActivity.kt:159
                                  (binding.tvNickname.text = it)
Notes:                   tv_nickname is declared in 34 layouts; foreground
                         Activity uniquely disambiguates to EditProfileActivity.
                         (Same evidence simultaneously satisfies Scenario C's
                         disambiguation contract.)
```

1. `android_debug_start_session` per the projectRoot block above.
2. Navigate to a screen with a clearly-id'd, obviously-clickable element. The
   login screen's primary CTA, or any settings list row whose id is in
   `com.baitu.poppo:id/*`, work; pick whichever your account state reaches
   without side effects.
3. (Optional) `android_debug_capture { runId, kinds: ["ui_dump"] }` to get a
   pre-tap dump for picking exact coordinates.
4. `android_debug_tap_node { runId, x: <px>, y: <py>, label: "<button label>" }`.
5. Feed the response's `anchorNode`, `preTapForegroundActivity`, and
   `ancestorChain` into `android_debug_map_ui_node_to_source { runId, anchorNode,
   foregroundActivity: <preTapForegroundActivity>, ancestorChain }`.
6. `android_debug_stop_session { runId }`.

- [x] `tap_node` returns `anchorNode != null` and
      `anchorSource ∈ {"tapped_node", "ancestor"}`.
- [x] The pre-tap dump file `artifacts/ui-<preTapCaptureId>.xml` exists under
      the run's folder.
- [x] `map_ui_node_to_source` returns `confidence: "high"`.
- [x] `signals[]` contains all of: `resource_id_present`,
      `resource_package_matches_session`, `layout_declares_id`, `code_refs_found`.
- [x] `candidates[]` contains at least one `id_declaration`, one
      `screen_owner`, and one `code_ref`.
- [x] The `code_ref` candidate's `file` matches the resolved `screen_owner`
      candidate's `file` (i.e. the handler lives inside the owner).
- [x] `events.jsonl` for the run contains one `tap_node` event and one
      `source_mapping` event.
- [x] `commands.jsonl` for the run contains ≥1 `{ tool: "map_ui_node_to_source",
      rg: "..." }` line.

## Scenario B — no anchor

**Goal:** a tap on a node with no app-package `resource-id` ancestor produces
a soft `none` result — no error, no false-positive candidates.

```text
Scenario:                B — no anchor (map-side contract)
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
Poppo package / version: com.baitu.poppo / 3.13.0.17.1
Poppo repo SHA:          f9fc1099b6d9adbb77afa21ede26d2d77d26ad5b
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
runId / runDir:          2026-05-25T03-35-21.378Z_Ui2F (shared with A/C/E —
                         only D requires a separate run)
Target (probe):          divider region in EditInformationNicknameActivity
                         x=540 y=1400 (decorative android.view.View, no id)
tap_node output:         anchorNode = com.baitu.poppo:id/contentLayout (ancestor)
                         anchorSource = "ancestor"  ← NOT "none"
                         preTapForegroundActivity = .../EditInformationNicknameActivity
                         (real-device limitation — see notes)
map output:              (called with anchorNode = null per step 4 explicit instruction)
                         confidence = "none"
                         reason   = "No resource-id anchor was provided; there is
                                     nothing to map."
                         signals  = []
                         candidates = []
Notes:                   On Poppo, every Activity's window contains the id'd
                         containers `com.baitu.poppo:id/swipe`,
                         `…/action_bar_root`, `…/contentLayoutBase`. Any in-window
                         tap therefore bubbles up to at least one app-id ancestor;
                         tap_node cannot empirically produce `anchorNode:null` +
                         `anchorSource:"none"` against this app. Mapping null
                         is exercised via step 4's explicit override; tap_node's
                         `anchorSource:"none"` contract is locked by
                         server/tests/mcp/tap_node.test.ts:155
                         ("reports anchorSource none when the tapped node carries
                         no app resource-id").
```

1. `android_debug_start_session` as above (projectRoot still required so the
   negative path is observed against a real source tree, not a missing one).
2. Navigate to a screen with a region that empirically lacks any
   `com.baitu.poppo:id/*` near the tap point — a decorative `TextView` with no
   id, a wallpaper area in a `FrameLayout`, or a system status-bar inset.
3. `android_debug_tap_node { runId, x, y, label: "no-anchor probe" }`.
4. `android_debug_map_ui_node_to_source { runId, anchorNode: null,
   foregroundActivity, ancestorChain }` — pass `null` even if the tool already
   resolved it; the assertion is on the `map` side.
5. `android_debug_stop_session`.

- [!] `tap_node` does **not** error. It returns `anchorNode: null` and
      `anchorSource: "none"`. **`anchorNode:null` not reproducible on Poppo
      (root containers always carry app ids); vitest covers the contract at
      `server/tests/mcp/tap_node.test.ts:155`. tap_node DID NOT error — it
      returned `anchorSource:"ancestor"` resolving to `contentLayout`.**
- [x] `map_ui_node_to_source` returns `confidence: "none"` and
      `candidates: []`.
- [x] `signals[]` is empty (`resource_id_present: false` short-circuits
      classification).
- [x] `map`'s `reason` mentions the missing anchor.
- [x] `events.jsonl` contains both events; no error log is written for this run.

## Scenario C — ambiguity disambiguated

**Goal:** an `id` declared in ≥2 layouts is resolved to the right owner via
the foreground Activity cross-check; `signals[]` reflects the disambiguation,
not `owner_ambiguous`.

**Pre-flight — pick a duplicated id.** From the Poppo checkout:

```bash
/opt/homebrew/bin/rg --no-heading -n '@\+id/' submodulepoppo/app/src/main/res/layout \
  | sed -E 's/.*@\+id\/([A-Za-z0-9_]+).*/\1/' | sort | uniq -d | head
```

(The bare `rg` shell alias is intercepted by RTK; use the explicit path when
running interactively.) Pick one that you can navigate to (an id in a layout
inflated by a screen you can reach without side effects).

```text
Scenario:                C — ambiguity disambiguated
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
Poppo package / version: com.baitu.poppo / 3.13.0.17.1
Poppo repo SHA:          f9fc1099b6d9adbb77afa21ede26d2d77d26ad5b
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
runId / runDir:          2026-05-25T03-35-21.378Z_Ui2F
Target:                  com.baitu.poppo:id/nickname (FrameLayout)
                         in EditProfileActivity, x=200 y=1619
                         id declared in 54 layouts (the duplicate)
tap_node output:         anchorNode = com.baitu.poppo:id/nickname (FrameLayout)
                         anchorSource = "tapped_node"
                         preTapForegroundActivity = .../editprofile.EditProfileActivity
map output:              confidence = "high"
                         reason = "The id resolves to a single screen owner,
                                   confirmed by the foreground Activity, with
                                   a code reference inside it."
                         signals = [resource_id_present, resource_package_matches_session,
                                    layout_declares_id,
                                    layout_inflated_by_foreground_activity,
                                    code_refs_found]
                         id_declarations = many (54)
                         screen_owner candidates:
                           - EditProfileActivity.kt:50  ← matches foreground simple name
                           - PurchasingGuardFragment.kt:57 (non-foreground)
                         code_ref in resolved owner = EditProfileActivity.kt:105
                                  (binding.nickname.onClick { nickname() })
                         owner_ambiguous = false (foreground singled out one owner)
```

1. `start_session` as above.
2. Navigate to the Activity / Fragment that inflates the layout containing the
   chosen id. Confirm via `adb shell dumpsys activity activities | head -40` if
   unsure.
3. `tap_node` on the element.
4. `map_ui_node_to_source` with the tap result.
5. `stop_session`.

- [x] `tap_node` returns a non-null `anchorNode`.
- [x] `map_ui_node_to_source` returns `confidence: "high"` or `"medium"`.
- [x] `signals[]` does **not** include `owner_ambiguous`.
- [x] `signals[]` includes `layout_inflated_by_foreground_activity`.
- [x] `candidates[]` contains ≥2 `id_declaration` entries.
- [x] Exactly one `screen_owner` candidate has a `file` whose basename without
      extension equals the simple class name of `preTapForegroundActivity`
      (e.g. `LoginActivity.kt` ↔ `…/LoginActivity`).
- [x] If `confidence: "high"`, the `code_ref` candidate's file matches that
      same owner file.

## Scenario D — failure semantics

This scenario has two independent subchecks. Run them as separate runs (each
gets its own `start_session` and `runId`).

### D-a — pre-tap `uiautomator dump` failure → `ui_dump_failed`, no tap

**Goal:** when the pre-tap dump fails, `tap_node` returns a hard error and the
`input tap` is never sent (no `tap_node` event written).

```text
Scenario:                D-a — pre-tap dump failure
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
Host repro:              skipped — lock-screen / USB-disconnect race not chased
                         per handoff guidance ("If not reproducible, do not
                         chase it — record the vitest fallback and move on.")
vitest evidence:         server/tests/mcp/tap_node.test.ts:172
                           "fails with ui_dump_failed and does NOT tap when
                            the pre-tap dump fails"
                         server/tests/mcp/tap_node.test.ts:213
                           "fails with ui_dump_failed when the dumped XML is
                            unparseable, and does NOT tap"
Result:                  bun run test tests/mcp/tap_node.test.ts → 7/7 passed
                         (rerun at d50b695)
```


Host repro is best-effort; common triggers are locking the device or
disconnecting USB between the call dispatch and `uiautomator dump`. If neither
is reproducible on this device, fall back to the vitest evidence below.

**Host attempt:**

1. `start_session` (projectRoot optional for D-a — the failure is on the runtime side).
2. Lock the device or pull USB briefly, then immediately:
3. `android_debug_tap_node { runId, x: 100, y: 100, label: "dump-fail probe" }`.
4. Reconnect / unlock.
5. `stop_session`.

- [!] `tap_node` returns `{ isError: true, code: "ui_dump_failed" }` (or
      another hard adb error if the disconnect path won the race — in which
      case retry with the lock path). **Host repro skipped; vitest covers it
      (see ledger).**
- [!] `events.jsonl` contains **no** `tap_node` event for this attempt.
      **Host repro skipped; vitest asserts the no-tap invariant.**
- [!] The device shows no spurious tap at (100, 100) — i.e. `input tap` did
      not run. **Host repro skipped; vitest asserts the no-tap invariant.**

**vitest fallback (always runs):** the contract is unit-tested by
`server/tests/mcp/tap_node.test.ts` — `pre-tap dump failure` case asserts the
hard error + absence of `input tap`. If the host run above could not be
forced, record this fallback path in the evidence ledger and treat the unit
test as the canonical proof.

### D-b — `rg` not on PATH → `rg_not_found`

**Goal:** `map_ui_node_to_source` returns a hard `rg_not_found` when ripgrep
is unavailable; no partial `source_mapping` event is written.

```text
Scenario:                D-b — rg_not_found
Date / operator:         2026-05-25 / est9
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
D-b verified via:        server/tests/source/rg.test.ts
                         server/tests/mcp/map_ui_node_to_source.test.ts
Host repro:              skipped (would require global PATH mutation).
Result:                  bun run test tests/source/rg.test.ts → 9/9 passed
                         bun run test tests/mcp/map_ui_node_to_source.test.ts → 9/9 passed
                         (rerun at d50b695)
```


Host repro requires mutating the server's `PATH` (or moving the `rg` binary)
to make `which rg` fail, then restarting the server — a global-state change
the acceptance run should not perform. Use the targeted test instead.

**vitest evidence (canonical):**

- `server/tests/source/rg.test.ts` covers `RgNotFoundError` directly.
- `server/tests/mcp/map_ui_node_to_source.test.ts` asserts the `rg_not_found`
  hard-error path on the tool boundary.

Record under the evidence ledger:

```text
D-b verified via: server/tests/source/rg.test.ts
                  server/tests/mcp/map_ui_node_to_source.test.ts
Host repro: skipped (would require global PATH mutation).
```

- [x] `bun run test -- rg.test.ts` passes at the commit under test.
- [x] `bun run test -- map_ui_node_to_source.test.ts` passes at the commit
      under test.
- [x] Manual note recorded in the evidence ledger per the format above.

## Scenario E — RecyclerView row id reuse caps confidence

**Goal:** a tap on a row child inside a `RecyclerView` / `ListView` /
`GridView` gets `confidence: "low"` with `recycled_row_id` in `signals[]`,
because the id alone cannot tell which row was tapped.

Use the **关注 / 粉丝列表** (followers/followees list) — it has the right
shape (typed `RecyclerView` with per-row `binding.<x>` children) and the data
can be made stable in a dev account.

```text
Scenario:                E — RecyclerView row id reuse
Date / operator:         2026-05-25 / est9
Device serial / API:     951a20a2 / 33
Poppo package / version: com.baitu.poppo / 3.13.0.17.1
Poppo repo SHA:          f9fc1099b6d9adbb77afa21ede26d2d77d26ad5b
MCP server commit:       d50b695d859f9c945b358fa7cb6cd8300ecc9d72
runId / runDir:          2026-05-25T03-35-21.378Z_Ui2F
Target:                  first row's ivAddFav (ImageView) at x=990 y=441,
                         inside ContactsActivity's recycler_view.
                         Reached via Me-tab → follow_layout (which on this
                         device opens ContactsActivity, not a dedicated
                         followers/followees activity — same RecyclerView
                         shape, qualifies the contract).
tap_node output:         anchorNode = com.baitu.poppo:id/ivAddFav (ImageView)
                         anchorSource = "tapped_node"
                         ancestorChain contains:
                           com.baitu.poppo:id/ivAddFavLayout (LinearLayout)
                           androidx.recyclerview.widget.RecyclerView ← row container
                         preTapForegroundActivity = .../contacts.ContactsActivity
map output:              confidence = "low"
                         reason = "The tapped node sits inside a recycling
                                   container (RecyclerView/ListView/GridView);
                                   its id is reused across rows, so confidence
                                   is capped."
                         signals = [resource_id_present,
                                    resource_package_matches_session,
                                    layout_declares_id, code_refs_found,
                                    owner_ambiguous, recycled_row_id]
                         id_declaration = item_contact_list.xml:198 (+ a constraint
                                          ref in item_guard_contacts_list.xml)
Deviation [需要 nod]:    E's checklist item "signals[] does NOT include
                         owner_ambiguous" is over-specified for Poppo: even the
                         row-only id `ivAddFav` is referenced in two layouts
                         (`item_contact_list.xml`, `item_guard_contacts_list.xml`),
                         and the recycler-row container has no BaseBinding…<…>
                         screen owner — so `idLayoutFiles.size >= 2` and
                         `foregroundMatchedOwners.length === 0`, making
                         `owner_ambiguous = true` by the (correct) formula. The
                         dominant cap is still `recycled_row_id`: classify()
                         short-circuits on it (recipe.ts intent), so the verdict
                         is `low` with the recycling-reason. The contract — "row
                         recycling caps confidence; the reason cites recycling" —
                         is met. Suggest relaxing the checklist to: signals[]
                         includes `recycled_row_id`, AND the reason cites
                         recycling (not declaration ambiguity).
```

1. Log into Poppo with the dev account before starting.
2. `start_session` as above.
3. Navigate to the followers or followees list.
4. `tap_node` on a row child element (e.g. the avatar or the username text in
   a row).
5. `map_ui_node_to_source` with the tap result.
6. `stop_session`.

- [x] `tap_node` returns a non-null `anchorNode`.
- [x] `ancestorChain[].class` contains at least one entry whose class name
      includes `RecyclerView`, `ListView`, or `GridView`.
- [x] `map_ui_node_to_source` returns `confidence: "low"`.
- [x] `signals[]` includes `recycled_row_id` AND `resource_id_present` AND
      `resource_package_matches_session` AND `layout_declares_id`.
- [!] `signals[]` does **not** include `owner_ambiguous` (the cap is due to
      row recycling, not declaration ambiguity). **owner_ambiguous IS in
      signals for Poppo's `ivAddFav` (declared in 2 layouts). recycled_row_id
      is still the dominant cap per classify() order; reason cites recycling.
      See ledger — flagged as `[需要 nod]` for a checklist relaxation.**
- [x] `map`'s `reason` mentions recycled rows / RecyclerView.
- [x] `candidates[]` contains ≥1 `id_declaration` (the row item layout).

---

## After all five

- [x] `bun run lint && bun run typecheck && bun run test` still green at the
      commit being audited.
- [x] Each scenario has a filled-in evidence ledger committed (or pasted into
      the audit message — final form is the auditor's call).
- [x] Any newly harvested fixtures under `server/tests/fixtures/ui/` are
      committed and their derived parser/hit-test tests pass. **No new
      fixtures were harvested for this acceptance run — existing
      poppo-overlay.xml / poppo-follow-list.xml / poppo-homepage.xml cover
      the scenarios; no parser/hit-test gap surfaced on the live device.**
