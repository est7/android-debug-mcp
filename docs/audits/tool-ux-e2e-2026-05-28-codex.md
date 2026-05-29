# android-debug MCP tool UX e2e audit — 2026-05-28

## Scope

本报告记录一次面向 agent 上手直觉的非破坏性 e2e 走查。目标不是验证单个 runtime happy path 是否可用，而是检查 MCP tool contract 是否让 agent 第一次调用就能走对、错参后能否自然恢复、默认返回是否足够有用且不过量。

本轮未调用 `android_debug_clear_app_data`，未导出 raw log bundle。

## Test Runs

| runId | package | Purpose | Result |
|---|---|---|---|
| `2026-05-28T15-15-44.007Z_NEMq` | `com.baitu.poppo` | Broad non-destructive tool sweep | App foreground, no crash |
| `2026-05-28T15-21-24.251Z_daJ2` | `com.baitu.poppo` | Initial homepage API attempt; later identified as `MainActivity`, not `HomepageActivity` | Valid run, wrong screen for the user question |
| `2026-05-28T15-24-03.983Z_MB5P` | `com.baitu.poppo` | Real path into `HomepageActivity` via `navMe -> mine_user_info_view` | `HomepageActivity` foreground, homepage APIs captured |
| `2026-05-28T15-27-03.815Z_mNk4` | `com.baitu.poppo` | Error recovery and contract edge checks | Stopped, no crash |

Device: `951a20a2`, model `M2012K11AC`, API 33.

## What Worked Well

### Error guidance is already good in several places

These errors gave a clear next step and should be used as wording templates:

- `search_evidence({source:"poppo_http", excludeHeartbeat:true})` rejects with `query_underspecified` and explains that `excludeHeartbeat` alone does not narrow.
- `search_logs(buffer:"main")` rejects with `query_underspecified` and explains that `buffer`, `excludeTags`, and `cursor` alone do not narrow.
- `search_evidence(fullRecords:true, limit:20)` rejects with `fullRecords:true requires limit <= 10; for more, paginate with cursor`.
- `collect_bundle(logs:"raw")` rejects with `confirmation_required` and suggests `logs:"redacted"`.

### `tap_node -> map_ui_node_to_source` is strong

The top search/icon area on `MainActivity` mapped from UI to source with high confidence:

- `fragment_main_live.xml`
- `MainLiveFragment.kt`
- `binding.topBarLayout.setOnSearchListener()`

This flow is intuitive because the tap result carries `anchorNode` and `ancestorChain`, and the follow-up mapping tool accepts exactly those fields.

## Findings

### P0 — `search_evidence(pathPrefix=...)` is not session-scoped by default

Observed in run `2026-05-28T15-27-03.815Z_mNk4`:

- run started at `2026-05-28T15:27:03.815Z`
- `search_evidence(pathPrefix:"/homepage")` returned a `/homepage` record at approximately `2026-05-28T15:25:07Z`
- adding explicit `tsMsRange.from = run.startedAt` returned no records

Source confirms the behavior is intentional today:

- `server/src/profile/poppo-vone/poppo_http/source.ts`: `bindSession()` only clamps to `sessionStartMs` when the caller already supplied `tsMsRange`.

Why this is dangerous:

- Agent intuition is "search this run's evidence"; current behavior is "search pulled evidence files for this run folder, but matching records may predate this MCP session unless the agent adds `tsMsRange`."
- For tasks like "show HomepageActivity requests", this can silently mix old page visits with the current reproduction.

Recommendation:

1. Add `sessionScoped` default behavior for agent-facing `search_evidence`, or add a default `tsMsRange` bounded by `sessionStartMs` when query omits time.
2. If keeping current behavior, return an explicit warning when query omits `tsMsRange`: `records may predate this MCP session; pass tsMsRange or use extract_evidence_context for marker-scoped inspection`.
3. Make the tool description state this in the first paragraph, not buried in source comments.

### P0 — redacted bundle still contains sensitive patterns

Observed bundle:

`/Users/est9/AndroidStudioProjects/submodulepoppo/.android-debug-runs/bundles/bundle-2026-05-28T15-27-03.815Z_mNk4.tar.gz`

Pattern scan found sensitive strings in:

- `logcat.redacted.jsonl`
- `evidence/poppo_http/http_2026-05-28_0.jsonl`

Patterns hit:

- `_sign=`
- `smei_id`
- `Set-Cookie`
- device uuid-like value `9906b772cd3b27a0`

The same bundle also contained 14 macOS AppleDouble `._*` entries.

Recommendation:

1. Add a post-bundle denylist scan for redacted exports; fail closed if sensitive patterns remain.
2. Extend evidence redaction beyond `_sign` and authorization headers to cover `smei_id`, `uuid`, `_uid` when appropriate, cookies, and known device identifiers.
3. Exclude `._*` and `.DS_Store` from archive creation.

### P1 — `poppo_http` default output is too raw for agent use

Default `search_evidence` and `extract_evidence_context` responses include:

- full URL query with `_sign`, `_uid`, `smei_id`, `uuid`
- request params
- response headers including `Set-Cookie`
- large body text previews

This hurts both safety and task focus. For a page/API question, the useful default is usually:

```text
ts, method, path, status, durationMs, app.ok, app.code, app.message,
request.decoded safe params, response.body.textBytes, truncatedFields
```

Recommendation:

1. Make `summary` or `preview` the default record shape.
2. Move raw URL, headers, params, and body behind `fullRecords:true`.
3. Add `fields` or `view` option if callers need a specific subset: `summary`, `headers`, `params`, `bodyPreview`, `raw`.

### P1 — predictable validation errors are not consistently domain errors

Observed:

`extract_evidence_context(beforeMs:120000)` returns MCP/Zod `-32602` validation output:

```text
beforeMs must be <= 60000
```

It does not suggest the correct recovery path.

Better message:

```text
beforeMs must be <= 60000. For a wider window, call search_evidence with query.tsMsRange:{from,to}; extract_evidence_context is intentionally capped to marker-adjacent inspection.
```

Recommendation:

1. Move high-risk numeric bounds into both schema descriptions and tool prose.
2. Wrap predictable schema failures into the same domain envelope shape used by tool handlers:

```json
{"error":"query_malformed","message":"...","nextAction":"..."}
```

### P1 — `search_logs(level=E)` defaults to noisy system evidence

Observed:

`search_logs(afterMark:"ux_audit_marker", level:"E")` returned repeated system-level noise:

- `WifiScoreReportInjector`
- `PowerKeeper.Thermal`
- unrelated AndroidRuntime/uiautomator lines

The app-specific records were mixed in but not highlighted.

Recommendation:

1. Add `appOnly:true` or `pidScope:"current"` for common debugging tasks.
2. Consider returning `source:"app" | "system" | "tooling"` classification.
3. When results include many non-app records, include a warning suggesting `tags` or `pidScope`.

### P1 — annotated capture ordering is not human-first

On `HomepageActivity`, `capture(annotateElements:true, clickableOnly:true)` returned dynamic/list cells first, while top toolbar controls appeared much later:

- `backButton`: annotation 23
- `shareButton`: annotation 24
- `editButton`: annotation 25

Agent behavior follows the returned list. If the first 10 elements are list content, the agent is likely to miss top-level navigation/actions.

Recommendation:

1. Add `order:"visual"` or make visual top-left order the default for annotated clickable elements.
2. Consider grouping by zones: `topBar`, `content`, `bottomNav`, `floating`.
3. Include a compact `elementSummary` with high-value controls first.

### P1 — `list_runs` ignores explicit run roots

Observed:

- Runs created with `projectRoot=/Users/est9/AndroidStudioProjects/submodulepoppo`
- `list_runs(limit:10)` only listed runs under `/Users/est9/AndroidStudioProjects/android-debug-mcp/.android-debug-runs`

Recommendation:

1. Add `projectRoot` or `runRoot` to `list_runs`.
2. If omitted, return a `runRoot` scope warning.
3. Consider indexing explicit run roots used by active/recent sessions.

### P2 — action tools return too little confirmation

Tools like `tap`, `send_key`, `swipe`, and `long_press` generally return only `ts`.

This is composable, but weak for agent self-correction. Agents immediately need a follow-up `capture` or `get_app_state`.

Recommendation:

Add optional `verifyAfter` with small, bounded output:

```json
{
  "ts": "...",
  "post": {
    "activity": "...",
    "foreground": true,
    "uiSummary": {"nodeCount": 123, "clickableCount": 20}
  }
}
```

### P2 — direct Activity opening needs a documented fallback

Attempting direct shell start for `HomepageActivity` failed:

```text
Permission Denial ... not exported
```

This is expected because manifest declares `HomepageActivity` with `android:exported="false"`.

The correct path was UI navigation:

```text
MainActivity -> navMe -> mine_user_info_view -> HomepageActivity
```

Recommendation:

For "open screen X" workflows, document the decision tree:

1. Check manifest/exported.
2. If exported, use explicit start with extras.
3. If not exported, use in-app navigation and verify with `get_app_state`.

## HomepageActivity Correct API Evidence

The corrected `HomepageActivity` run was `2026-05-28T15-24-03.983Z_MB5P`.

Foreground confirmation:

```text
com.baitu.poppo/com.androidrtc.chat.modules.homepage.HomepageActivity
```

Captured APIs:

```text
GET /homepage              200 app=ok code=200  480ms  body=8714 bytes
  decoded params: uid=37142512, created_in=else

GET /dynamic/sliders       200 app=ok code=200  324ms  body=358 bytes
  decoded params: uid=37142512

GET /user/share-link-auth  200 app=ok code=200  316ms  body=220 bytes

GET /content/v2/list       200 app=ok code=200  557ms  body=15578 bytes
  decoded params: uid=37142512, page=1, limit=21, type=""
```

## Suggested Patch Slices

1. **Contract wording slice**
   - Promote numeric limits and next actions in tool descriptions.
   - Add `nextAction` to common query errors.
   - Clarify `search_evidence` session/time semantics.

2. **Output shape slice**
   - Add summary-first preview for `poppo_http`.
   - Hide raw URL/query/header/body by default.
   - Add compact `elementSummary` for annotated capture.

3. **Safety slice**
   - Harden evidence/log/bundle redaction.
   - Add post-bundle denylist scan.
   - Exclude AppleDouble files.

4. **Runtime semantics slice**
   - Decide whether `search_evidence` should be session-scoped by default.
   - Add `projectRoot/runRoot` to `list_runs`.
   - Add `pidScope/appOnly` to `search_logs`.

5. **Verification slice**
   - Add regression tests for:
     - evidence query without `tsMsRange` warning or default scoping
     - redacted bundle denylist
     - `beforeMs > 60000` actionable error
     - visual ordering or grouped annotation output
     - explicit run root listing
