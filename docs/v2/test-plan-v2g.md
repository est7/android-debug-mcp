# Manual test plan — v2-G profile + evidence acceptance

The eight scenarios from [`./profile-and-evidence.md`](./profile-and-evidence.md)
§ Acceptance scope, as a manual device checklist. Automated coverage lives in
`server/tests/` (730 / 730 at HEAD `42d048b`); this plan is the on-device
acceptance pass — run it before tagging `v0.4.0`.

The design lock's contract is *what* each scenario must prove; this file is
*how* to prove it on the device, with the evidence each run leaves behind.

## Prerequisites

- `bun run lint && bun run typecheck && bun run test` green at the commit under
  test (baseline 730 / 730 as of `42d048b`).
- A device in `adb devices` state `device`. The primary target is Poppo on
  POCO F3 serial `951a20a2` (or whatever device you actually have).
- The MCP server wired into a host (Cursor / Claude Desktop / equivalent) per
  the [README](../../README.md), with `ANDROID_DEBUG_MCP_RUN_ROOT` set to a
  scratch directory. **Use a real host — do not spawn the server through a
  one-off script for acceptance.** A scripted spawn can validate a different
  transport / config path than the one users actually run.
- Poppo installed: `applicationId = com.baitu.poppo`. A debug build (release
  build doesn't write `http-logs/` — that's scenario S7).
- The Poppo `CustomHttpLoggingInterceptor` already wired in
  `submodulepoppo/rtcrequestlibrary` (precondition for v2-G; backlog § v2-G
  依赖前置).
- `<projectRoot>/.android-debug-mcp/profile.json` writeable by the test runner
  (scenarios S1, S2, S8 toggle it).

## Evidence ledger — fill at the top of each scenario

```text
Scenario:                <S1|S2|S3|S4|S5|S6|S7|S8>
Date / operator:         <YYYY-MM-DD / handle>
Device serial / API:     951a20a2 / <api>      (adb shell getprop ro.build.version.sdk)
Poppo package / version: com.baitu.poppo / <versionName>
                                              (adb shell dumpsys package com.baitu.poppo | rg versionName)
Build type:              <debug|release>      (adb shell pm dump com.baitu.poppo | rg debuggable)
Poppo repo SHA:          <sha>                 (cd submodulepoppo && git rev-parse HEAD)
MCP server commit:       42d048b               (cd android-debug-mcp && git rev-parse HEAD)
profile.json:            <present|absent|malformed|unknown-name>
runId / runDir:          <runId> / <path>      (from start_session)
key tool outputs:        <verbatim JSON or excerpt>
```

A subcheck that cannot be exercised on the host records its evidence as a path
to the relevant vitest file plus a one-line note explaining why host repro was
skipped — same fallback shape v2-A / v2-F used in their test plans.

## start_session preamble (common to all scenarios)

```text
android_debug_list_devices                          → expect 1 entry; copy `deviceSerial`
android_debug_start_session                          → arguments: { packageName: "com.baitu.poppo",
                                                                    projectRoot: "<path-to-poppo-checkout>",
                                                                    launchOnStart: true }
```

Capture `runId` + `runDir` from the response. The session is the same identity
across all eight scenarios; you can either restart between scenarios (safer) or
chain S3 → S4 → S5 → S6 in one session (faster, but if a scenario fails the
state is mixed).

When a scenario calls for `profile.json` manipulation, do it BEFORE
`start_session` (the profile is read at session start; mid-session changes are
ignored).

---

## S1 — Profile load happy

**What it proves**: `loadProfile` resolves `<projectRoot>/.android-debug-mcp/profile.json`
to the built-in `poppo-vone` profile; `metadata.profile.json` reflects the
nodded shape; `search_evidence({source:"poppo_http"})` recognises the source.

### Setup

```bash
# In the poppo project root (NOT the MCP repo):
mkdir -p .android-debug-mcp
cat > .android-debug-mcp/profile.json <<'EOF'
{ "name": "poppo-vone", "version": 1 }
EOF
```

### Steps

1. `android_debug_start_session` per § preamble.
2. Inspect the new run's metadata:
   ```bash
   cat <runDir>/metadata.json | jq '.profile'
   ```
   Expect `{"name": "poppo-vone", "version": 1}`.
3. Inspect the pre-created source dir:
   ```bash
   ls -la <runDir>/evidence/
   ```
   Expect a `poppo_http/` subdirectory (manager.start pre-creates it).
4. `android_debug_search_evidence` with `{ runId, query: { source: "poppo_http" } }`.
   - Records may be 0 if no traffic yet — what matters is **no warnings**,
     **no error**, and `statsRun.pullsTriggered` consistent (1 if files exist on
     device, 0 if `http-logs/` is empty).

### Pass criteria

- ✅ `metadata.json` carries the right profile name + version literal `1`.
- ✅ `evidence/poppo_http/` dir exists pre-pull.
- ✅ `search_evidence` returns success (no `isError`); `warnings` either absent
  or empty.

---

## S2 — Profile broken (`profile_malformed` / `profile_unknown`)

**What it proves**: hard error paths at session start surface as typed
`ToolDomainError`, not protocol errors; run folder is NEVER materialized with
a half-resolved profile.

### Setup A — malformed JSON

```bash
echo "not json" > <projectRoot>/.android-debug-mcp/profile.json
```

### Steps A

1. `android_debug_start_session` per § preamble.
2. Expect `r.isError === true` and `r.content[0].text` parses to
   `{"error": "profile_malformed", "message": "...", "path": "..."}`.
3. Confirm NO new run folder was created under `runRoot`:
   ```bash
   ls <runRoot>/com.baitu.poppo/u0/ | sort -r | head -1
   # The most recent runId should be a PREVIOUS run (or empty); nothing minted by this attempt.
   ```

### Setup B — unknown profile name

```bash
cat > <projectRoot>/.android-debug-mcp/profile.json <<'EOF'
{ "name": "no-such-profile", "version": 1 }
EOF
```

### Steps B

1. `android_debug_start_session` per § preamble.
2. Expect `r.isError === true` with `error: "profile_unknown"` and extras
   `{name: "no-such-profile", known: ["poppo-vone", ...]}`.
3. Confirm no new run folder again.

### Pass criteria

- ✅ Both cases return `isError:true` with the right typed `error` code.
- ✅ No run folder side-effects (`acquireLock` released, `createRunDir` rolled
  back).
- ✅ Re-running with a valid `profile.json` succeeds without `singleton_violation`
  (the tuple lock from the failed attempt was freed).

---

## S3 — `search_evidence` happy (lazy pull + records returned)

**What it proves**: first `search_evidence` call after session start triggers
a lazy pull, writes `evidence_pulled` event, and surfaces records through the
source's `matchQuery`. Tests the full lazy-pull runtime path end-to-end on
real adb.

### Setup

1. Profile loaded per S1.
2. Drive Poppo to generate some HTTP traffic — `launchOnStart` already did
   one launch; do a few app interactions (login screen / 关注 list refresh /
   anything that hits `https://...v.show/`). Goal: at least 5-10 records in
   `http-logs/`.

### Steps

1. `android_debug_search_evidence`:
   ```json
   { "runId": "<runId>", "query": { "source": "poppo_http", "tsMsRange": { "from": 0 }, "excludeHeartbeat": true } }
   ```
   `tsMsRange.from:0` is clamped to `sessionStartMs` by the source's
   `bindSession`, so behavior is "all session traffic"; the explicit
   range satisfies v0.4.0 Block A's `validateNarrowingFilter`
   ("bare {source}" is now `query_underspecified`). `excludeHeartbeat`
   is still allowed alongside; it's a negative filter that only counts
   when paired with a positive one.
2. Capture the response:
   - `records.length` > 0
   - `statsRun.pullsTriggered` > 0 (first call → cache miss → pull)
   - `statsRun.pulledFiles` lists at least one `http_<date>_<idx>.jsonl` basename
3. Confirm the event was written:
   ```bash
   rg '"type":"evidence_pulled"' <runDir>/events.jsonl
   # Should match at least one line with "trigger":"lazy" and the source / files fields.
   ```
4. Confirm the command was recorded:
   ```bash
   rg '"tool":"search_evidence"' <runDir>/commands.jsonl
   # Should match with statsRun / pullsTriggered / pulledFiles fields.
   ```
5. Spot-check a record: it should have `tsMs >= sessionStartMs` (bindSession
   floor working). If you see any record below the session start, R1 is broken.

### Pass criteria

- ✅ `search_evidence` returns records.
- ✅ `evidence_pulled` event in events.jsonl with `trigger:"lazy"`.
- ✅ commands.jsonl aggregate row written.
- ✅ All returned records' `tsMs >= sessionStartMs` (bindSession R1 working).

---

## S4 — `extract_evidence_context` window math

**What it proves**: `extract_evidence_context` decorates the source query with
`tsMsRange = [marker - beforeMs, marker + afterMs]`, runs the same lazy-pull
pipeline, and echoes back the resolved range.

### Setup

Continue from S3 — session active, records available.

1. Take an interesting event from `<runDir>/events.jsonl` — easiest is to
   manually run `android_debug_mark_event` with a name like `"acceptance_s4"`
   right after a notable Poppo action.
2. Read the `ts` of that mark from events.jsonl.

### Steps

1. `android_debug_extract_evidence_context`:
   ```json
   {
     "runId": "<runId>",
     "markerIsoTs": "<ts-copied-verbatim>",
     "beforeMs": 5000,
     "afterMs": 5000,
     "query": { "source": "poppo_http", "excludeHeartbeat": true }
   }
   ```
   `extract_*_context` injects `tsMsRange` from the marker before
   dispatch, so the v0.4.0 Block A narrowing check is auto-satisfied —
   no need for an explicit positive filter here. `excludeHeartbeat`
   alone IS valid in this tool for the same reason.
2. Confirm:
   - `tsMsRange.from === Date(markerIsoTs).getTime() - 5000`
   - `tsMsRange.to === Date(markerIsoTs).getTime() + 5000`
   - All `records` have `tsMs` inside that window (inclusive on both ends)
3. Try the `query.tsMsRange` rejection path:
   ```json
   {
     "runId": "<runId>",
     "markerIsoTs": "<ts>",
     "query": { "source": "poppo_http", "tsMsRange": { "from": 0 } }
   }
   ```
   Expect `isError:true` with `error: "invalid_argument"` mentioning that this
   tool owns `tsMsRange`.

### Pass criteria

- ✅ `tsMsRange` echoed = marker ± window.
- ✅ Returned records all fall inside the echo.
- ✅ Agent-supplied `tsMsRange` is rejected as `invalid_argument`.

---

## S5 — Lazy pull mtime hit (no re-pull on second call)

**What it proves**: the mtime cache short-circuits the second
`search_evidence` call when the device file's mtime hasn't changed; no new
`evidence_pulled` event is emitted; commands.jsonl still records the call.

### Setup

Continue from S3 / S4 — at least one `search_evidence` already pulled some
files. Note the count of `evidence_pulled` lines:

```bash
rg -c '"type":"evidence_pulled"' <runDir>/events.jsonl
```

### Steps

1. **Without doing any Poppo interaction** (so the active log file's mtime
   doesn't change), call `search_evidence` again with any query.
2. Confirm `statsRun.pullsTriggered === 0` in the response.
3. Re-count `evidence_pulled` events:
   ```bash
   rg -c '"type":"evidence_pulled"' <runDir>/events.jsonl
   # Should equal the pre-call count — NO new lines added.
   ```
4. Confirm commands.jsonl DID grow (every call records):
   ```bash
   rg -c '"tool":"search_evidence"' <runDir>/commands.jsonl
   # Should be exactly one more than before.
   ```
5. Now do a Poppo interaction that generates a new HTTP request, wait 2-3s,
   re-call `search_evidence`. Confirm `pullsTriggered === 1` (active file mtime
   grew → pull again).

### Pass criteria

- ✅ Second call's `pullsTriggered === 0`, no new `evidence_pulled` event.
- ✅ commands.jsonl row added every call.
- ✅ After mtime change, third call DOES re-pull.

---

## S6 — `stop_session` seal + `collect_bundle` redact verify

**What it proves**: `stop_session` triggers a force-pull on every declared
source regardless of cache, writes `evidence_pulled` with `trigger:"seal"`,
and `collect_bundle` then applies Q6 redaction to the staged evidence files
(headers + `_sign`/`_random` in URL) before tar.

### Setup

Continue from S3-S5 — session active, evidence already pulled at least once
(so there's a baseline mtime in the cache).

### Steps

1. Drive Poppo to generate at least one more request after the last
   `search_evidence` call (so the active file's mtime is ahead of the cache).
2. `android_debug_stop_session` with `{ runId }`.
3. Confirm a new `evidence_pulled` event with `trigger:"seal"`:
   ```bash
   rg '"trigger":"seal"' <runDir>/events.jsonl
   # Should match at least one line, source=poppo_http, files non-empty.
   ```
4. `android_debug_collect_bundle` with `{ runId, logs: "redacted" }`.
5. Extract the bundle to a scratch dir and inspect:
   ```bash
   mkdir /tmp/v2g-bundle-check
   tar -xzf <bundlePath> -C /tmp/v2g-bundle-check
   ls /tmp/v2g-bundle-check/<runId>/evidence/poppo_http/
   # Expect *.jsonl files; .mtime-cache.json must be ABSENT.
   ```
6. Inspect a record in the bundled evidence file. Check:
   ```bash
   head -1 /tmp/v2g-bundle-check/<runId>/evidence/poppo_http/http_<date>_0.jsonl \
     | jq '{url, request_headers: .request.headers, response_headers: .response.headers}'
   ```
   - Any `Authorization`/`Cookie`/`Set-Cookie`/`Set-Cookie2`/`Proxy-Authorization`
     header value MUST be `"[REDACTED]"`.
   - The `url` field, if it had `_sign` or `_random`, MUST carry
     `_sign=%5BREDACTED%5D` (URL-encoded placeholder).
   - The `request.params` for `_sign`/`_random` MUST be `"[REDACTED]"` (raw).
   - Other fields (`response.body.text`, `request.decoded`, `error.message`)
     MUST be **raw** — Q6 says "其他全 raw".

### Pass criteria

- ✅ `evidence_pulled` with `trigger:"seal"` written at stop.
- ✅ Bundle contains evidence/poppo_http/*.jsonl, NO `.mtime-cache.json`.
- ✅ Sensitive header values redacted.
- ✅ `_sign`/`_random` redacted in BOTH `request.params` (raw `[REDACTED]`)
   AND `url` (URL-encoded `%5BREDACTED%5D`).
- ✅ `response.body.text` left raw (Q6 scope).

---

## S7 — Release build (no `http-logs/` dir) → soft empty

**What it proves**: a release build (where the `CustomHttpLoggingInterceptor`
doesn't write) yields a soft-empty result, not an error. Tests the "missing
dir" path in `listDeviceFiles`.

### Option A — actual release APK

1. Build / install Poppo release variant.
2. Confirm no `/sdcard/Android/data/com.baitu.poppo/files/http-logs/` exists:
   ```bash
   adb shell ls /sdcard/Android/data/com.baitu.poppo/files/http-logs/
   # Should print "No such file or directory".
   ```
3. Run `android_debug_start_session` + `android_debug_search_evidence` per S1+S3.
4. Expect:
   - `isError:false`
   - `records.length === 0`
   - `statsRun.pullsTriggered === 0`
   - NO `evidence_pulled` event written

### Option B — debug build but artificially missing dir

If a release build isn't easily available, mimic it:

```bash
# After start_session, BEFORE search_evidence:
adb shell rm -rf /sdcard/Android/data/com.baitu.poppo/files/http-logs/
```

Then run S3's steps. Outcome should match Option A.

### Pass criteria

- ✅ No error.
- ✅ Empty records, zero pulls, zero events.
- ✅ commands.jsonl still records the call (audit trail intact).

---

## S8 — Vanilla project (no profile.json) → tools visible + soft return

**What it proves**: `search_evidence` / `extract_evidence_context` are
**always registered** (inventory 23 fixed); a vanilla project without
`profile.json` doesn't error out — it soft-empties with an explicit warning.

### Setup

```bash
# In a non-Poppo / non-Vone project root:
rm -rf .android-debug-mcp
# Or, simpler: pick a packageName for an app that doesn't have a poppo-vone
# profile assigned. The point is to start a session where loadProfile returns null.
```

### Steps

1. `android_debug_start_session` with `packageName` for any installed app
   AND `projectRoot` pointing at a dir with no `.android-debug-mcp/profile.json`.
2. Confirm `metadata.profile === null`:
   ```bash
   cat <runDir>/metadata.json | jq '.profile'
   # null
   ```
3. List tools (via your MCP host's tool inventory inspector OR a direct call
   if exposed). Confirm both `android_debug_search_evidence` and
   `android_debug_extract_evidence_context` are listed.
4. `android_debug_search_evidence` with `{ runId, query: { source: "poppo_http" } }`.
5. Expect:
   - `isError:false`
   - `records.length === 0`
   - `warnings` contains one entry like `"session has no profile loaded; source 'poppo_http' has no provider"`
   - `statsRun` all zeros
6. `android_debug_extract_evidence_context` similarly returns soft-empty +
   warning, AND echoes the resolved `tsMsRange`.

### Pass criteria

- ✅ Tools always registered (inventory: 23 entries).
- ✅ No protocol error.
- ✅ Soft-empty records + explicit warning naming the missing-profile / missing-source.
- ✅ Tools still write commands.jsonl audit rows (with `softEmpty:true`).

---

## Finalization

After all 8 scenarios pass:

1. Update this file's "evidence ledger" sections with the captured outputs
   inline (or attach as a sibling `test-plan-v2g-evidence.md` if too verbose).
2. Tag `v0.4.0` per [`./v2-g-implementation-plan.md`](./v2-g-implementation-plan.md)
   § Release.
3. Update [`../backlog.md`](../backlog.md) § v2-G to "promoted + acceptance
   complete" pointer.

If any scenario fails, do NOT tag. Open a fix branch, address, and re-run the
affected scenario(s) only — but capture which prior scenarios still hold so
you don't have to re-walk all eight.
