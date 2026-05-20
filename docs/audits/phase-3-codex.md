# Phase 3 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-3`
**Outcome:** **patch-required** (3 P1 lifecycle failure-path bugs + 1 P2)
**Source message id:** `2026-05-20T02-26-50.038Z_pid30501_706d6b5c`

> Sign-off note from codex: "The main issue is not Phase 4 logcat readiness; it is that lifecycle failure paths can strand or hide sessions before logcat is added."

---

## Findings

### P1

- **[P3-P1-1] start_session strands the session on post-registration failure.** `start_session.ts:88-153` + `manager.ts:125-127` — the session is registered + timers armed inside `manager.start()`, but metadata enrichment / `logcat -c` / launch / `session_start` event all run *after*. Any throw there fails the tool call before a `runId` is returned, yet the manager still owns an active session + tuple lock. Caller has no runId to stop it; next start for the tuple is blocked. **Patch:** wrap post-start work; on failure best-effort failure event → finalize as `aborted` (release lock/streams) → unregister tuple → surface a typed error. Test: force `patchMetadata`/`appendEvent` to throw after `manager.start()`, assert no active session/tuple remains.

- **[P3-P1-2] `SessionManager.stop()` leaks the tuple index when finalize throws.** `session.ts:141-153` + `manager.ts:175-178` — `stop()` calls `unregister()` only after `finalize()` resolves. If `closeStreams()` / metadata patch throws, the lock is freed (finalize `finally`) and `isActive` flips false, but `tupleIndex` is never cleared → next start for the tuple rejects `singleton_violation` while the session is invisible (`listActive()` empty). Codex reproduced directly. **Patch:** `stop()` must `unregister()` in a `finally`. Keep `lock.release()` in `Session.finalize()` finally (that part is correct).

- **[P3-P1-3] auto-stop strands the session if the timeout-event write fails.** `manager.ts:185-190` — `handleTimeout()` awaits `appendEvent()` before `finalize()`. The timer already fired and cleared both timers, so an append failure leaves an active session with no future timeout and no unregister. **Patch:** timeout event write is best-effort; finalize + unregister regardless. Test: event-stream append rejects → session still finalizes, tuple freed.

### P2

- **[P3-P2-4] malformed packageName + clearLocalRunLogs leaks IdentityError as a protocol error.** `start_session.ts:83-86` + `run.ts:111-113` — `clearClosedRuns` calls `assertSafePackageName` and throws `IdentityError` *before* `startWithIdentityGuard()` converts it. **Patch:** validate/convert identity before `clearClosedRuns`. Test: `packageName:"../evil", clearLocalRunLogs:true` → `isError:true` with `invalid_identity`.

## Codex answers to requested decisions

- Redaction pulled into Phase 3: **accepted** (mark_event needs it; baked-in #4 locked).
- Redaction substring matching: **accepted** for v1 — over-redaction is the right bias.
- `ToolDomainError` → `isError:true` no `structuredContent`: **accepted directionally**. Right domain/protocol split. **Add a register-helper test for this transport path** when patching (current register tests cover only registration contracts).
- `launchOnStart` failure no rollback: **accepted** for the normal `{launched:false}` result — does NOT cover unexpected throws after `manager.start()` (that is P3-P1-1).
- `get_app_state` not resetting idle: **accepted**.
- `finalize()` lock release in `finally`: **accepted**, but manager unregister must also be exception-safe (P3-P1-2).

## Verification codex ran

- `bun run typecheck` ✅ / `bun run lint` ✅ 52 files / `bun run test` ✅ 16 files / 166 tests
- Direct Bun lifecycle probe: reproduced the `tupleIndex` desync after `closeStreams()` failure.

## Patch plan (本方接受)

1. **[P3-P1-2]** `SessionManager` — extract `teardown(session, endStatus)` that calls `finalize()` then `unregister()` in a `finally`; `stop()` / `abort()` both route through it.
2. **[P3-P1-3]** `handleTimeout` — wrap the `auto_stopped_by_timeout` append in try/catch (best-effort), then `teardown` regardless.
3. **[P3-P1-1]** new `SessionManager.abort(session)` (finalize `aborted` + unregister); `start_session` wraps all post-`manager.start()` work in try/catch → on throw `abort` + rethrow.
4. **[P3-P2-4]** `start_session` validates `packageName` (→ `invalid_identity`) before `clearClosedRuns`.
5. **register helper** — extract `wrapToolHandler(config, handler)`, unit-test the 3 transport paths (success / `ToolDomainError` → `isError` / non-domain throw → propagates).
6. Tests: manager finalize-failure frees tuple; handleTimeout append-failure frees tuple; in-memory tool harness for the `start_session` post-start-failure cleanup + the `../evil` identity case.

---

# Phase 3 — Patch round 1

**Date:** 2026-05-20

## Applied

- **[P3-P1-2]** `SessionManager` — `teardown(session, endStatus)` runs `finalize()` then `unregister()` in a `finally`; `stop()` / new `abort()` route through it. Tuple index is freed even when `finalize()` throws.
- **[P3-P1-3]** `handleTimeout()` — the `auto_stopped_by_timeout` append is wrapped in try/catch (best-effort, logged on failure); `teardown()` runs regardless.
- **[P3-P1-1]** `SessionManager.abort()` (finalize `aborted` + unregister). `start_session` wraps every post-`manager.start()` step in try/catch → on throw `await manager.abort(session)` then rethrow → the tuple/lock/streams are freed, the caller can retry.
- **[P3-P2-4]** `start_session` validates `packageName` via `guardIdentity(assertSafePackageName)` BEFORE `clearClosedRuns` / `manager.start` → malformed input surfaces as `invalid_identity` instead of leaking a protocol error.
- **Follow-on bug found while patching** — `Session.finalize()` originally skipped `closeStreams()` when `patchMetadata()` threw, leaking FileHandles. Rewrote `finalize()` to run all three teardown steps (metadata / streams / lock) independently and rethrow the first error.
- **register helper** — extracted `wrapToolHandler(config, handler)`; unit tests cover success / `ToolDomainError`→`isError` / non-domain-throw / outputSchema-violation.

## Tests added (177 total, was 166)

- `register.test.ts` — 4 `wrapToolHandler` transport cases.
- `manager.test.ts` — finalize-failure frees tuple; `abort()` frees tuple; auto-stop-with-failing-event-write frees tuple. Added `SessionManager.registeredCount()` as the teardown-complete signal (`isActive`/`listActive()` flip at finalize *start*, not end).
- `start_session.test.ts` (new, in-memory MCP client/server harness) — `../evil` → `invalid_identity`; happy path; post-start failure aborts (no strand); retry after post-start failure succeeds.

## Verify

- `bun run typecheck` ✅ / `bun run lint` ✅ 53 files / `bun run test` ✅ **177/177** — all gates re-run after the final edit.
- Real-device probe re-run: start → mark → get_app_state → `clear_app_data{confirm:false}` rejected with `confirmation_required` → app_control(stop) → stop_session, all correct.

## Known carry-forward (flagged, not patched this round)

- `server/src/adb/adb.ts` still uses `Bun.spawn` / `Bun.spawnSync`, so it is not exercised under vitest's Node runtime. `start_session.test.ts` mocks the adb layer to stay hermetic. The `Bun → node:child_process` switch is deferred to Phase 4, where logcat's streaming consumer of `spawnAdb` will be written and can drive the new interface.

---

# Phase 3 — Codex audit reply (round 2)

**Date:** 2026-05-20
**Thread:** `review/phase-3`
**Outcome:** **patch-required** (1 new P1 — same failure class as P3-P1-3, on explicit stop)
**Source message id:** `2026-05-20T02-51-57.161Z_pid52807_c0fe62e0`

Round-1's four findings + the follow-on `finalize` fix all **accepted**.

## New blocking finding

- **[P3-R2-P1] stop_session strands the session if the `session_stop` event write fails.** `stop_session.ts:49-52` — the tool wrote the `session_stop` lifecycle event *before* `manager.stop()`. A failed append meant `manager.stop()` was never reached → session stays active, tuple locked. Same class as the auto-stop append bug (P3-P1-3) but on explicit stop. Codex reproduced by monkey-patching `AppendStream.append` to throw on the stop path: active/registered stayed 1, same-tuple restart rejected `singleton_violation`.

  **Fix:** explicit stop must always attempt teardown even when the event write fails.

## Codex verification

- `bun run typecheck` / `lint` (53 files) / `test` (17 files / 177) all pass.
- Direct Bun probe reproduced the pre-`manager.stop()` append failure stranding the session.

# Phase 3 — Patch round 2

- `SessionManager.stop()` now writes the `session_stop` lifecycle event itself, best-effort (try/catch + `log.warn`), then runs `teardown()` — mirroring `handleTimeout()`'s `auto_stopped_by_timeout` handling. `stop_session.ts` no longer writes the event; it just calls `manager.stop(session)`.
- New regression test (`manager.test.ts`): `stop()` with a failing `session_stop` append still finalizes, `registeredCount()` reaches 0, and the same tuple can start again.
- Verify: `typecheck` ✅ / `lint` ✅ 53 files / `test` ✅ **178/178**; real-device probe confirms `stop_session` still writes `session_stop` to `events.jsonl`.

---

# Phase 3 — Codex audit reply (round 3 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-3`
**Outcome:** **sign-off** — Phase 3 cleared to proceed to Phase 4.
**Source message id:** `2026-05-20T02-54-59.062Z_pid56898_449b5a45`

## Codex review notes

- `SessionManager.stop()` now writes `session_stop` best-effort, then always `teardown(session, "stopped")` — matches the timeout-path contract; event append failure cannot block finalize/unregister.
- `stop_session.ts` only resolves the session + delegates to `manager.stop()`; no append-before-teardown edge.
- `manager.test.ts` regression covers the failure mode (forced `session_stop` append rejection → stop resolves, `registeredCount()` 0, tuple restartable).

## Codex verification

- `bun run typecheck` ✅ / `bun run lint` ✅ 53 files / `bun run test` ✅ 17 files / 178 tests

## Outcome

No remaining Phase-3 lifecycle blocker. The `Bun.spawn` → `node:child_process` carry-forward stays deferred to Phase 4 as scoped.

## Phase 4 carry-forward checklist

- [ ] `server/src/adb/adb.ts` — switch `Bun.spawn` / `Bun.spawnSync` → `node:child_process` so the adb layer is exercisable under vitest. Do it alongside logcat's first `spawnAdb` streaming consumer.
