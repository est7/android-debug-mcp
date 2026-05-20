# Phase 9 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-9`
**Outcome:** **patch-required** (1 P2 — `stop_session` reported `stopped` for a degraded run)
**Source message id:** `2026-05-20T09-21-05.638Z_pid57110_ddbc8883`

---

## Codex reply (verbatim)

Patch-required: one contract inconsistency remains.

Finding:
1. P2 — `stop_session` reports `stopped` for degraded runs.
   Evidence: `Session.finalize()` now preserves a degraded terminal metadata status (`server/src/session/session.ts:177`, then writes it at `server/src/session/session.ts:204-205`), but `stop_session` still constrains the response schema to `stopped | aborted` (`server/src/mcp/tools/stop_session.ts:19`) and maps every non-aborted final status to `stopped` (`server/src/mcp/tools/stop_session.ts:62`). In Scenario D this means metadata / `get_run_summary` report `degraded`, while the immediate `stop_session` structured response says `stopped`. That is observable contract drift and can mislead MCP callers that rely on `stop_session` without fetching the summary.
   Patch: include `degraded` in the `stop_session` output schema and return the actual `finalMeta.status`; add a regression assertion in the disconnect test that `stop_session` itself returns `degraded` after the monitor marks the session degraded.

Reviewed notes:
- The fixed 5s monitor interval is acceptable for v1; no start_session config needed.
- No reconnect healing is acceptable; terminal degraded is the intended current contract.
- No SIGTERM-specific handler is acceptable given Phase 8 orphan recovery owns crash/kill recovery.
- The current `listDevices()` failure behavior is acceptable for this phase: it avoids false degradation when adb itself is unavailable.

Verification run locally:
- `bun run typecheck` — pass.
- `bun run lint` — pass, 109 files.
- `bun run test -- server/tests/mcp/disconnect.test.ts` — pass, 6 tests.
- `bun run test` — pass, 38 files / 354 tests.

---

## Patch (本方接受)

`stop_session`'s output `status` field now reuses the canonical
`RunStatusSchema` (`active|degraded|stopped|aborted`) instead of
`z.enum(["stopped","aborted"])`, and the handler returns `finalMeta.status`
directly rather than collapsing every non-aborted status to `stopped`. A
degraded run now reports `degraded` consistently across `stop_session`,
`metadata.json`, and `get_run_summary`. The disconnect regression test now
asserts `stop_session`'s own response is `status:"degraded"`. Verify: 354/354.

---

# Phase 9 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-9`
**Outcome:** **sign-off** — Phase 9 cleared to commit and proceed to Phase 10.
**Source message id:** `2026-05-20T09-24-14.217Z_pid63941_0e169d2c`

---

## Codex reply (verbatim)

Sign-off.

The P2 is patched correctly:
- `stop_session` now uses the canonical `RunStatusSchema` (`server/src/mcp/tools/stop_session.ts:4`, `server/src/mcp/tools/stop_session.ts:19`).
- The handler returns `finalMeta.status` directly (`server/src/mcp/tools/stop_session.ts:66`), so degraded terminal metadata is no longer flattened to `stopped`.
- The disconnect regression now asserts `stop_session` itself reports `status: "degraded"` before checking `get_run_summary` (`server/tests/mcp/disconnect.test.ts:191-208`).

No blocking findings.

Verification run locally:
- `bun run typecheck` — pass.
- `bun run lint` — pass, 109 files.
- `bun run test -- server/tests/mcp/disconnect.test.ts` — pass, 6 tests.
- `bun run test` — pass, 38 files / 354 tests.

Non-blocking note: `RunStatusSchema` is broader than the actual `stop_session` terminal response shape because it also includes `active`, but the handler reads metadata after `manager.stop()`, so this is acceptable as canonical-schema reuse for this phase.

---

## Disposition

Sign-off accepted. The non-blocking note (`RunStatusSchema` includes `active`,
which `stop_session` never returns post-`manager.stop()`) is accepted as
canonical-schema reuse — no code change.
