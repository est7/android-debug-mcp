# Phase 13 — Codex final-pass audit (v1 acceptance)

The v1 capstone review. Codex synthesized the per-phase audits
(`phase-1-codex.md` … `phase-12-codex.md`) with the Phase 13 real-device
acceptance and judged v1 readiness.

---

## Round 1 — patch-required

**Date:** 2026-05-20 · **Thread:** `review/phase-13`
**Outcome:** **patch-required** (1 P2 — the Phase 13 `crashFound` fix was not regression-locked at the metadata/tool-contract level)
**Source message id:** `2026-05-20T14-58-58.414Z_pid16677_ef022057`

### Codex reply (verbatim)

PATCH-REQUIRED

Final verdict: v1 is not ready to cut until one P2 regression-test gap in the Phase 13 crashFound fix is closed. The runtime fix itself looks correct, and the full local gate is green, but the committed Vitest coverage does not lock the actual bug that acceptance found.

P2 — Phase 13 crashFound fix is not regression-locked at the metadata/tool-contract level.

Evidence:
- server/src/session/session.ts:193-197 is the live-session fix: Session.finalize folds info.crashMarkers > 0 into metadata.crashFound. This is the line that fixes the externally visible bug.
- server/tests/logcat/channel.test.ts:142-163 only asserts LogcatChannel.shutdown() returns crashMarkers === 1 after a FATAL EXCEPTION line. It does not assert Session.finalize writes metadata.crashFound, nor that stop_session / get_run_summary / list_runs observe crashFound:true for a live cleanly-stopped crash run.
- Current grep confirms the gap: crashFound assertions in tests cover defaults / summary rendering / existing fixture records, while the new Phase 13 path only asserts info.crashMarkers. If the session.ts crashFound fold is removed, the new channel test can still pass and the original acceptance bug can return.

Why this blocks final v1-ready, but not as a P1:
- The real-device Phase 13 probe is strong evidence that the code works now.
- But this was a real release-blocking metadata contract bug affecting stop_session, get_run_summary, and list_runs. For the final release gate, CI should fail if the actual metadata fold regresses; otherwise the fix is only half regression-locked.

Requested patch:
- Add a committed Vitest regression that exercises the live-session crash path through Session.finalize or the MCP stop/summary path. Minimal acceptable assertion: feed a FATAL EXCEPTION through the fake logcat channel, stop/finalize the live session, then assert metadata.crashFound === true. Better: also assert stop_session and/or get_run_summary structuredContent.crashFound is true.
- The existing channel.test crashMarkers assertion can stay; it is useful but should be paired with the metadata/tool-level assertion.

Other final-pass checks:
- Phase audit synthesis: docs/audits/phase-1..phase-12 exist and each earlier patch-required phase has a later sign-off round.
- v1 deliverables: server/src, server/tests with 8 logcat fixtures, README quickstart, docs/backlog.md are present. Explicit out-of-scope items architecture.md / emulator CI / bun build --compile are correctly absent from v1.
- Deferred items reviewed: IME restore, capture command adb field, worker-level UTF-8 byte-split test, getPackageVersion null for system apps, and earlier cursor/scanned notes are acceptable documented deferrals; none should block v1.
- Release commit expectation after this P2: package.json 0.1.0-dev -> 0.1.0 is expected. Also commit the final Phase 13 audit artifact/status update if that is part of this repo workflow; no additional binary/CI/architecture deliverable is expected for v1.

Verification run:
- Targeted: bun run test -- server/tests/logcat/channel.test.ts server/tests/session/manager.test.ts server/tests/mcp/evidence.test.ts server/tests/mcp/disconnect.test.ts -> 4 files passed / 32 tests passed.
- Full: bun run lint && bun run typecheck && bun run test -> lint checked 114 files; typecheck passed; Vitest 40 files passed / 386 tests passed.

Verdict: PATCH-REQUIRED. Close the P2 with a metadata/tool-level crashFound regression, then this should be eligible for final v1 sign-off.

### Patch (本方接受)

NEW `server/tests/mcp/crash_found.test.ts` — drives the real MCP tool stack
(`start_session` → `stop_session` → `get_run_summary`) over a fake
`LogcatChannel` whose `shutdown()` reports a driveable `crashMarkers` count.
`crashMarkers = 2` → both `stop_session` and `get_run_summary`
`structuredContent.crashFound === true`; `crashMarkers = 0` → both `false`.
The test fails if `Session.finalize`'s `crashFound` fold is removed.

---

## Round 2 — sign-off

**Date:** 2026-05-20 · **Thread:** `review/phase-13`
**Outcome:** **SIGN-OFF — v1-ready.**
**Source message id:** `2026-05-20T15-01-31.876Z_pid20817_f4fe2192`

### Codex reply (verbatim)

SIGN-OFF

Final verdict: v1-ready. The Phase 13 P2 is closed.

Re-review scope: the previous P2 required a metadata/tool-contract regression for the live-session crashFound fold, not just a LogcatChannel shutdown-stat assertion.

Checks performed:
- server/tests/mcp/crash_found.test.ts now drives the real MCP tool stack: start_session -> stop_session -> get_run_summary.
- Test 1 sets fake LogcatChannel shutdown crashMarkers = 2 and asserts stop_session structuredContent.crashFound === true plus get_run_summary structuredContent.crashFound === true. This locks the Session.finalize metadata fold.
- Test 2 sets crashMarkers = 0 and asserts both tools report crashFound === false, so the regression also protects the clean-run branch.
- server/src/session/session.ts still folds crashFound: info.crashMarkers > 0 during live finalize; server/src/logcat/channel.ts still forwards worker stats into LogcatShutdownInfo; channel.test.ts keeps the lower-level crashMarkers assertion.

Verification run:
- bun run test -- server/tests/mcp/crash_found.test.ts server/tests/logcat/channel.test.ts -> 2 files passed / 7 tests passed.
- bun run lint && bun run typecheck && bun run test -> lint checked 115 files; typecheck passed; Vitest 41 files passed / 388 tests passed.

Final acceptance synthesis:
- Phase audits: docs/audits/phase-1..phase-12 exist; prior patch-required phases have later sign-off rounds.
- v1 deliverables: server/src, server/tests with 8 logcat fixtures, README quickstart, docs/test-plan.md, and docs/backlog.md are present.
- v1 out-of-scope items remain correctly out of scope: docs/architecture.md, emulator-based CI, and bun build --compile binary release.
- Documented deferrals remain acceptable for v1: IME restore, capture command adb-field note, worker-level UTF-8 byte-split test, getPackageVersion null for system apps, and earlier cursor/scanned telemetry notes. None should block v1.
- Release commit expectation: package.json 0.1.0-dev -> 0.1.0 plus the Phase 13 final audit artifact/status update. No additional binary, CI, or architecture artifact is expected for v1.

Verdict: SIGN-OFF. v1 is ready after this Phase 13 patch is included.
