# v2-G acceptance evidence ledger — 8/8 PASS (2026-05-26)

Companion to [`./test-plan-v2g.md`](./test-plan-v2g.md). Each scenario's
captured outputs and key pass-criterion evidence. Test plan is the *spec*;
this file is what we actually saw on the wire.

## Common context (all scenarios)

| Field | Value |
|---|---|
| Date / operator | 2026-05-26 / est9 |
| Device | `951a20a2` — POCO F3 (`M2012K11AC`) — Android 13 (API 33) — arm64-v8a |
| Poppo package / version | `com.baitu.poppo` / `3.13.0.17.1` / versionCode `31300171` |
| Build type | `debug` (DEBUGGABLE flag set) |
| Poppo repo SHA | `35cd72ab218ba1a50e97719f1cd6ec1ca82497b7` |
| profile.json | `{"name":"poppo-vone","version":1}` (S1, S3-S7) / malformed (S2A) / unknown name (S2B) / absent (S8) |
| `<projectRoot>` (S1-S7) | `/Users/est9/AndroidStudioProjects/submodulepoppo` |
| `<projectRoot>` (S8 vanilla) | `/Users/est9/AndroidStudioProjects/android-debug-mcp` (no `.android-debug-mcp/profile.json`) |
| runRoot resolution | `runRootSource:"explicit"` from `projectRoot` |

**MCP server tracks across the session**:
- `0.4.0-rc.1` (initial) — S1-S5 + S6 first attempt (S6 failed → fix #1)
- `0.4.0-rc.2` (post `d580f8d`, post-reconnect) — S6 PASS + S7 + S8 (audit during this run → fix #2)
- `0.4.0-rc.3` (post `c5588db`, **not yet pushed** at time of this doc) — gates baseline 747/747, all scenarios re-runnable under this rule shape

## S1 — Profile load happy ✅

| | |
|---|---|
| runId | `2026-05-26T10-26-13.847Z_H15y` |
| key tool | `search_evidence({source:"poppo_http"})` (rc.1 — pre-Block-A allowed bare) |

Pass:
- `metadata.profile` = `{"name":"poppo-vone","version":1}` ✓
- `evidence/poppo_http/` dir exists pre-pull (manager.start pre-created) ✓
- `search_evidence`: no `isError`, no `warnings`, 3 records returned, `statsRun.pullsTriggered=2`, 2 files pulled (`http_2026-05-25_0.jsonl` + `http_2026-05-26_0.jsonl`) ✓

## S2 — Profile broken ✅

### S2A — malformed JSON (`echo "not json" > profile.json`)

`start_session` returned `isError:true` with:
```json
{
  "error": "profile_malformed",
  "message": "profile.json at <path> is not valid JSON: JSON Parse error: Unexpected identifier \"not\"",
  "path": "/Users/est9/AndroidStudioProjects/submodulepoppo/.android-debug-mcp/profile.json"
}
```
runRoot listing pre-attempt vs post-attempt: identical (3 existing dirs, none minted by the failed attempt) ✓

### S2B — unknown profile name (`{"name":"no-such-profile","version":1}`)

`start_session` returned:
```json
{
  "error": "profile_unknown",
  "message": "profile.json at <path> names \"no-such-profile\", which is not in the built-in registry.",
  "path": "...",
  "name": "no-such-profile",
  "known": ["poppo-vone"]
}
```
runRoot listing again identical (no folder minted) ✓

### S2 recovery — lock freed

Restoring valid `profile.json` and re-calling `start_session` → success, new `runId=2026-05-26T10-27-23.249Z_gr3j`, NO `singleton_violation` (tuple lock from failed attempts cleanly released) ✓

## S3 — search_evidence lazy pull ✅

Continuing on `_gr3j`. Test plan query was `{source:"poppo_http", excludeHeartbeat:true}` (still legal under rc.1; would be `query_underspecified` under rc.3 — see § Re-run note below).

Pass:
- `records.length` = 2 (`/system/check-version` + `/system/mqtt-err`, both `heartBeat:false`)
- `statsRun.pullsTriggered` = 2; `pulledFiles` lists both `http_2026-05-25_0.jsonl` + `http_2026-05-26_0.jsonl`
- `events.jsonl` row written:
  ```json
  {"type":"evidence_pulled","source":"poppo_http","trigger":"lazy","files":["http_2026-05-25_0.jsonl","http_2026-05-26_0.jsonl"],"ts":"2026-05-26T10:28:16.149Z"}
  ```
- `commands.jsonl` aggregate row carries the same `statsRun` ✓
- First record `tsMs=1779791245497` → `2026-05-26T10:27:25.497Z`, **after** session start `10:27:23.249Z` → bindSession R1 floor working ✓

## S4 — extract_evidence_context window math ✅

Marker placed: `mark_event({name:"acceptance_s4"})` → `ts="2026-05-26T10:28:33.481Z"` → markerMs `1779791313481`.

### S4 happy (test plan literal: `excludeHeartbeat:true`)
```json
{
  "records": [],
  "statsRun": {"filesScanned":2,"recordsScanned":3356,"pullsTriggered":1,"pulledFiles":["http_2026-05-26_0.jsonl"]},
  "tsMsRange": {"from":1779791308481,"to":1779791318481}
}
```
- `tsMsRange.from === markerMs - 5000` ✓ (`1779791313481 - 5000 = 1779791308481`)
- `tsMsRange.to === markerMs + 5000` ✓
- `records:[]` because window only contained heartbeats which `excludeHeartbeat` filtered (substantive math verification via second call ↓)

### S4 substantive (drop `excludeHeartbeat` to prove a record actually falls in the window)
Returned 1 record `tsMs=1779791317991` ∈ `[1779791308481, 1779791318481]` ✓ (record sits 490 ms before window's right edge)

### S4 rejection
`query.tsMsRange:{from:0}` returned:
```json
{"error":"invalid_argument","message":"query.tsMsRange must not be set on extract_evidence_context — this tool injects tsMsRange from markerIsoTs/beforeMs/afterMs","tool":"extract_evidence_context"}
```
✓

## S5 — mtime cache hit ✅

**Setup note** (Boy-Scout flag): Poppo's `CustomHttpLoggingInterceptor` writes a heartbeat every ~10 s, so the active `http_2026-05-26_0.jsonl`'s mtime moves between two back-to-back `search_evidence` calls in steady state. To catch the strict `pullsTriggered=0` case we paused the producer with `adb shell am force-stop com.baitu.poppo` between Call A and Call B. NOT a v2-G bug; documented for future runs.

- Pre-Call-A counts: `evidence_pulled=5`, `search_evidence commands rows=3`
- Call A post-force-stop: `pullsTriggered=1`, `pulledFiles=[http_2026-05-26_0.jsonl]` (mtime had drifted since previous cache write)
- Call B immediately: `pullsTriggered=0`, `pulledFiles=[]` ← **cache hit** ✓
- Post-Call-B counts: `evidence_pulled=6` (only A added a row), `search rows=5` (both calls audited)
- Call C after Poppo relaunch + 12 s of new traffic: `pullsTriggered=1` ← mtime moved, re-pulled ✓

Throughout: the inactive `http_2026-05-25_0.jsonl` was NEVER in `pulledFiles` after its first pull, confirming partial cache-hit also works (it was always in cache).

## S6 — stop seal + collect_bundle redact ✅ (after fix #1)

### S6 seal (proven on `_gr3j` and `_27FC` independently)

`stop_session` on `_gr3j` wrote:
```json
{"type":"evidence_pulled","source":"poppo_http","trigger":"seal","files":["http_2026-05-25_0.jsonl","http_2026-05-26_0.jsonl"],"ts":"2026-05-26T10:33:05.081Z"}
```
Same shape on `_27FC` post-stop — force-pull on every declared source regardless of cache ✓

### S6 collect_bundle (rc.1 — FAILED, surfaced real v2-G regression)

`collect_bundle` against `_gr3j` (and subsequent attempts) failed with:
```
AppendStream(...evidence/poppo_http/http_2026-05-26_0.jsonl.tmp-redact-...) refused a 668036-byte line; cap is 65536 bytes.
```
Root cause investigated: 3 records in `http_2026-05-26_0.jsonl` each ~668 KB, all from the same endpoint:
```
GET asset.v.show/lang-dev/<version>:default/zh-hans/android/poppo/lang.json
```
Response body ~622 KB JSON of i18n string mappings — legitimate evidence, NOT PII. v2-G Phase 5 (i) evidence redact reused `AppendStream`'s 64 KiB cap (designed for events/logcat). Fix #1: `a80e723` (1 MiB option) + `d580f8d` (16 MiB final).

### S6 collect_bundle (rc.2 reconnect — PASSED)

`runId=2026-05-26T10-55-23.654Z_2WX9` (workaround: collected while session active, sidestepping the pre-existing v1 `resolveRunDir` cross-runRoot limitation in `server/src/store/locate.ts:27` — flagged in 不在范围).

Bundle: `bundle-2026-05-26T10-55-23.654Z_2WX9.tar.gz` (1,506,085 bytes). Spot-check post-extract:

| Q6 criterion | First record (`system/time`) | Big lang.json record (line 72, 668,341 bytes) |
|---|---|---|
| `evidence/poppo_http/*.jsonl` present | ✓ | ✓ |
| `.mtime-cache.json` ABSENT | ✓ | ✓ |
| Bundle round-trip | ✓ | ✓ **668,341 bytes intact, 10× old 64 KiB cap** |
| `_sign` in `request.params` → raw `"[REDACTED]"` | ✓ | n/a (no _sign on CDN url) |
| `_random` in `request.params` → raw `"[REDACTED]"` | ✓ | n/a |
| `_sign` in `url` → `%5BREDACTED%5D` | ✓ | n/a |
| `Set-Cookie` header → `"[REDACTED]"` | ✓ | n/a (CDN no Set-Cookie) |
| `response.body.text` left raw (Q6 scope) | ✓ (`{"code":200,...}`) | ✓ (`{"version":"...","language":{...}}`, 622 KB unchanged) |

Bundle artifact still on disk at:
```
/Users/est9/AndroidStudioProjects/submodulepoppo/.android-debug-runs/bundles/bundle-2026-05-26T10-55-23.654Z_2WX9.tar.gz
```

## S7 — release-build / missing http-logs/ → soft-empty ✅

Setup: `adb shell am force-stop com.baitu.poppo && adb shell rm -rf /sdcard/Android/data/com.baitu.poppo/files/http-logs/` (Option B).

`search_evidence({source:"poppo_http"})` returned:
```json
{"records":[], "statsRun":{"filesScanned":0,"recordsScanned":0,"pullsTriggered":0,"pulledFiles":[]}}
```
- no `isError` ✓
- `events.jsonl` `evidence_pulled` count = 0 (no event written) ✓
- `commands.jsonl` row still written (audit intact):
  ```json
  {"tool":"search_evidence","statsRun":{...all-zeros...},"pullsTriggered":0,"pulledFiles":[],"ts":"2026-05-26T10:57:11.370Z"}
  ```

## S8 — vanilla project (no profile.json) → tools visible + soft return ✅

`projectRoot=/Users/est9/AndroidStudioProjects/android-debug-mcp` (no `.android-debug-mcp/profile.json`).

- `metadata.profile` = `null` ✓
- 23 tools still listed (verified via the host's deferred-tool inventory; both `android_debug_search_evidence` and `android_debug_extract_evidence_context` present) ✓
- `search_evidence({source:"poppo_http"})`:
  ```json
  {"records":[], "warnings":["session has no profile loaded; source 'poppo_http' has no provider"], "statsRun":{...all-zeros...}}
  ```
- `extract_evidence_context({source:"poppo_http"}, markerIsoTs:"2026-05-26T10:57:00.000Z")`:
  ```json
  {"records":[], "warnings":[...same warning...], "statsRun":{...all-zeros...}, "tsMsRange":{"from":1779793015000,"to":1779793025000}}
  ```
  tsMsRange echoed even on the soft path ✓
- `commands.jsonl` rows carry `softEmpty:true` + the warning text ✓

## Findings discovered DURING acceptance (not in original test plan)

1. **Real v2-G regression (FIXED)** — bundle evidence-redact stream inherited `AppendStream`'s 64 KiB line cap; legitimate ~670 KB records blocked `collect_bundle`. Fixed in `a80e723` + `d580f8d`; regression test in `server/tests/store/jsonl.test.ts` ("honors maxLineBytes override…") + bundle-level test in `server/tests/bundle/bundle.test.ts` ("accepts an evidence record well above the default 64 KiB cap…").

2. **Real design defect (FIXED)** — audit found `search_evidence` + `search_logs` both allowed agent fetch-all (no required narrowing filter). Real worst case: ~50 MB / call. Fixed in `c5588db` (v0.4.0 Block A); regression tests in `server/tests/evidence/queryDispatch.test.ts` + `server/tests/profile/poppo-vone/poppo_http/source.test.ts` + `server/tests/mcp/evidence.test.ts`. Block B (per-record preview / truncation) deferred to v2-G.1 in `docs/backlog.md`.

3. **Pre-existing v1 limitation (NOT v2-G; flagged for v0.5.0 consideration)** — `server/src/store/locate.ts:27 resolveRunDir` does not find a stopped run that lived under a per-project runRoot if the server's no-arg `resolveRunRoot()` resolves elsewhere. S6 strict "stop → collect" ordering blocked by this; workaround was "collect while session active" — exercises the same redact + cap code path.

## Re-run note for rc.3

Test plan's literal S3 + S4 example queries (`{source:"poppo_http", excludeHeartbeat:true}`) would now return `query_underspecified` against rc.3 because `excludeHeartbeat` is a negative-only filter. Test plan was patched (`c5588db` companion to this evidence doc) to use `{source:"poppo_http", tsMsRange:{from:0}, excludeHeartbeat:true}` for S3; S4 unchanged since `extract_*_context` auto-injects `tsMsRange`. The bindSession R1 floor still clamps `from:0` to `sessionStartMs`, so observable behavior is identical to the original rc.1 / rc.2 run.
