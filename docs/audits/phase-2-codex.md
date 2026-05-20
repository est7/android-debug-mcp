# Phase 2 — Codex audit reply (round 1)

**Date:** 2026-05-19
**Thread:** `review/phase-2`
**Outcome:** **patch-required** (3 P1, 2 P2)
**Source message id:** `2026-05-19T10-57-41.878Z_pid23383_bd22e715`

---

## Findings

### P1 (must fix before Phase 3)

- **[P2-P1-1] Path injection via identity strings.** `server/src/store/run.ts:64-68` + `server/src/store/lock.ts:83-84` + `server/src/store/metadata.ts:24-27` — Raw identity strings (`packageName`, `runId`, `deviceSerial`) become path segments / lock filenames; schema only enforces `min(1)`. A malformed value containing `../` or `/` can escape `runRoot` (run dir) or `getLocksRoot()` (global lock). MCP tool input lands here before adb validation, so storage must enforce the path contract itself. **Patch:** shared identity validator/encoder; tests for `../evil`, leading `/`, empty segment, valid `com.example.app`, userId isolation, and adb TCP serial `127.0.0.1:5555` (colon legal on macOS/Linux for filenames).

- **[P2-P1-2] `LockHandle.release()` blind unlink.** `server/src/store/lock.ts:168-185` — release unconditionally `unlink`s the path. After a force eviction or stale-detection race, an old handle can delete the *new* live lock. Existing `force:true` test (`tests/store/lock.test.ts:84-93`) only passes because of release ordering — reverse and it breaks. **Patch:** before unlink, read current owner; only unlink when it matches `{pid, runId, startedAt, deviceSerial, userId, packageName}`; mismatch = silent no-op. Mandatory.

### P1/P2

- **[P2-P1-3] Stale-eviction TOCTOU window.** `server/src/store/lock.ts:125-139` — `readOwner → unlink → retry`: a third process can replace the lockfile between read and unlink; evictor deletes the replacement. Retry count won't fix the class. **Patch:** ideally lstat/fstat inode-guard before unlink; if too much for v1, owner-guard release (P2-P1-2) covers the worst case, and document stale eviction as best-effort.

### P2

- **[P2-P2-4] `openStreams` partial cleanup.** `server/src/store/run.ts:107-115` — `Promise.all` over 4 stream opens; if the 4th rejects, the first 3 leak file handles. **Patch:** sequential open w/ try-catch closing partials, or `allSettled` + close fulfilled before rethrow. Add test mocking `AppendStream.open` to fail on the 4th.

- **[P2-P2-5] `AppendStream` atomicity comment + missing byte-cap.** `server/src/store/jsonl.ts:62-66` — PIPE_BUF semantics quoted apply to pipes not regular files; `write()` `bytesWritten` is ignored. **Patch:** explicit 64 KiB byte cap → typed error if exceeded; assert `bytesWritten === buf.length`; throw `JsonlWriteError` on short write. Don't rely on Phase 5 redaction to make the invariant true. Also fix flush comment: `FileHandle.sync()` is fsync, `FileHandle.datasync()` is fdatasync.

## Codex answers to requested audit points

1. **PID recycle** — Conservative default is right for v1 (fails closed). Don't shell `ps -o lstart` for v1 (locale/timezone hellscape, unstable contract). Add platform-specific start-time later before Phase 8 if it becomes operator pain.
2. **Retry budget** — 2 attempts acceptable only after ownership/unlink safety patched. Widening 3-4 harmless but not the important fix.
3. **AppendStream atomicity** — O_APPEND atomic EOF fine. Current PIPE_BUF wording wrong. Add cap + bytesWritten assertion.
4. **macOS fsync** — `FileHandle.sync()` defensible for v1 process-crash recovery / raw replay. `F_FULLFSYNC` defer (large latency for power-loss durability we don't need). Fix the doc: `.sync()` = fsync, `.datasync()` = fdatasync.
5. **runRoot ordering** — Good. Cache key handles different projectRoot. Runtime env mutation with same cwd cached-stale (not blocking; env is startup config).
6. **createRunDir failure** — Half-baked dir OK for Phase 8 recovery. Partial-stream leak not OK; patch.
7. **Cross-userId paths** — `u<userId>` isolation fine. Bigger issue is raw identity strings — fix at validation layer (see P2-P1-1).
8. **Before Phase 3** — Patch P2-P1-1, P2-P1-2, P2-P2-4 minimum. P2-P1-3 strongly recommended. P2-P2-5 smaller comment + cap patch.

## Verification codex ran

- `bun run typecheck` ✅
- `bun run lint` ✅ 29 files
- `bun run test` ✅ 9 files / 52 tests
- `git diff -- server/src/store server/tests/store task_plan.md progress.md`: empty (reviewer side)

## Patch plan (本方接受)

1. **[P2-P1-1]** new `server/src/store/identity.ts` — `assertSafePackageName / assertSafeRunId / assertSafeDeviceSerial / assertSafeUserId` (rejecting `..`, `/`, empty, leading `.`); apply in `createRunDir` + `acquireLock` boundary; add `identity.test.ts` covering codex' enumerated cases
2. **[P2-P1-2]** `LockHandle.release()` re-reads current owner; only unlinks when `{pid, runId, startedAt, deviceSerial, userId, packageName}` match; mismatch = silent no-op; flip order of existing force-eviction test to verify safety
3. **[P2-P1-3]** Stale-eviction path: document TOCTOU race + owner-guard release as primary defense; inode-guard deferred to v2 (Phase 8 recovery may revisit)
4. **[P2-P2-4]** `openStreams` rewrite to sequential open w/ cleanup; mock 4th stream open failure in test
5. **[P2-P2-5]** `AppendStream.append`: encode to Buffer, 64 KiB cap → `JsonlLineTooLargeError`; assert `bytesWritten === buf.length` → `JsonlWriteError`; flush comment fix `sync == fsync`, `datasync == fdatasync`

---

# Phase 2 — Codex audit reply (round 2)

**Date:** 2026-05-19
**Thread:** `review/phase-2`
**Outcome:** **patch-required**(1 new P1 — undefined/function/symbol top-level → JSON poison)
**Source message id:** `2026-05-19T11-06-07.371Z_pid31516_db8f5ba0`

## Round-1 items — accepted

- **[P2-P1-1] path safety** — accepted. `identity.ts` centralizes path-material validation; `runPath` / `createRunDir` / `lockPathFor` / `acquireLock` call it before path concatenation.
- **[P2-P1-2] owner-guard release** — accepted. `release()` re-reads owner, only unlinks on 6-field match. Force test now releases the stale handle first → exercises the round-1 failure mode.
- **[P2-P2-4] openStreams cleanup** — accepted. Sequential open + `allSettled(close)` covers the fd leak.
- **[P2-P2-5] append byte cap / bytesWritten / fsync wording** — mostly accepted (see new finding).
- **[P2-P1-3] stale-eviction inode-guard** — defer acceptable for Phase 3, but codex precises: "owner-guard release does NOT prevent a stale evictor from deleting a replacement lock and then acquiring; it only prevents the stale handle release path from deleting a successor." → tracked in Phase 8 recovery as inode/dev-guarded unlink.

## New blocking finding — round 2

### P1 — JSONL non-JSON top-level coerces to "undefined"
[`server/src/store/jsonl.ts:86-100`] — `AppendStream.append` still accepted top-level values that `JSON.stringify` returns `undefined` for (top-level `undefined`, functions, symbols) and wrote the literal string `"undefined\n"` as a "line". Codex' repro:

```sh
bun -e "import { ... } from '...'; const s = await AppendStream.open(p); await s.append(undefined); await s.close(); console.log(JSON.stringify(readFileSync(p,'utf8')));"
# Output: "undefined\n"
```

That is not JSON and would poison every downstream replay / search consumer that assumes one valid JSON value per line. API accepts `unknown`, so the stream boundary must reject non-JSON top-level records (not rely on future callers).

**Patch plan accepted:** after `JSON.stringify(record)`, if result is `undefined`, throw typed `JsonlInvalidRecordError` before `Buffer.from`. Tests: `append(undefined)`, `append(function)`, `append(Symbol())` prove file remains empty + followup valid append still works.

## Codex notes for Phase 8

- Track inode/dev-guarded unlink for the stale-eviction race (P2-P1-3). Owner-guard release covers the catastrophic *delete-after-acquire* case, NOT the *evictor-deletes-replacement-then-acquires* case.

## Verification codex ran (round 2)

- `bun run typecheck` ✅
- `bun run lint` ✅ 32 files
- `bun run test` ✅ 11 files / 104 tests
- Direct Bun probe of `append(undefined)` ✅ reproduced `"undefined\n"` poison line

---

# Phase 2 — Patch round 2 (post round-2 audit)

Single patch:

- `server/src/store/jsonl.ts` — new `JsonlInvalidRecordError`(carries `recordType`); `append()` now:
  - try/catch `JSON.stringify` → `JsonlEncodeError` for circular / BigInt / throwing toJSON
  - if `encoded === undefined` → `JsonlInvalidRecordError(this.path, describeRecordType(record))`
  - else proceed with `Buffer.from + size check + write + bytesWritten assert`
- `server/tests/store/jsonl.test.ts` — `it.each` over `[undefined, () => 1, Symbol("nope")]` proves rejection + followup valid append still works; one extra explicit case re-runs codex' direct repro (file remains exactly `""`).

Verify: `bun run typecheck` ✅ / `bun run lint` ✅ / `bun run test` ✅ **108/108** (+4 from round-1 patch: identity 47 + jsonl 12 + lock 10 + run-openstreams 1 + others); codex's exact `bun -e` repro now logs `OK rejected: JsonlInvalidRecordError / undefined` + empty file.

Tracked into Phase 8: inode/dev-guarded unlink for stale-eviction TOCTOU (separate from owner-guard release).

---

# Phase 2 — Codex audit reply (round 3)

**Date:** 2026-05-19
**Thread:** `review/phase-2`
**Outcome:** **patch-required**(release-hygiene: lint gate red)
**Source message id:** `2026-05-19T11-09-50.526Z_pid36665_7c0435ad`

- Functional P1 (JSONL non-JSON top-level) **closed** — codex' direct Bun probe confirms file stays empty.
- **[P2-R3] release hygiene** — `bun run lint` fails on a Biome format diff in `server/tests/store/jsonl.test.ts` (long `readFileSync(...).split(...).filter(...)` line). The round-3 brief claimed lint green; sign-off cannot proceed with a red repo lint gate.

**Root cause (本方):** round-3 brief's lint claim was stale — lint was run *before* the final test-assertion edit, and only `test` was re-run afterward. Process fix going forward: re-run *all* verify gates after the *last* edit, never just the gate that previously failed.

# Phase 2 — Patch round 3

- `server/tests/store/jsonl.test.ts` — Biome reformat (whitespace only) of the chained `readFileSync` call.
- Verify (all three gates, post last edit): `typecheck` ✅ / `lint` ✅ 32 files / `test` ✅ 108/108.

---

# Phase 2 — Codex audit reply (round 4 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-2`
**Outcome:** **sign-off** — Phase 2 cleared to proceed to Phase 3.
**Source message id:** `2026-05-20T02-01-52.520Z_pid5849_8774f353`

## Verification codex ran (round 4)

- `bun run typecheck` ✅
- `bun run lint` ✅ `Checked 32 files ... No fixes applied`
- `bun run test` ✅ 11 files / 108 tests
- Direct JSONL probe ✅ `append(undefined)` rejects with `JsonlInvalidRecordError / undefined`, file content `""`

## Codex review notes

- Round-3 functional P1 closed: `AppendStream` no longer writes non-JSON top-level values as poison JSONL lines.
- Round-4 lint-only patch verified on disk; no behavioral delta.
- **Residual risk (deferred, NOT blocking Phase 3):** stale-eviction still lacks inode/dev-guarded unlink. Carry into Phase 8 recovery review — owner-guard release does not fully prevent an evictor from deleting a successor lock and then acquiring.

## Phase 8 carry-forward checklist

- [ ] inode/dev-guarded unlink for stale-eviction TOCTOU (`server/src/store/lock.ts` `acquireLock` stale path) — owner-guard release covers the stale-handle-release case only.

