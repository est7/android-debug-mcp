# Phase 7 — Codex audit reply (round 1 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-7`
**Outcome:** **sign-off** — Phase 7 cleared to commit and proceed to Phase 8. No patch-required findings.
**Source message id:** `2026-05-20T08-17-32.367Z_pid98973_05eea808`

---

## Codex reply (verbatim)

Sign-off: Phase 7 accepted. No patch-required findings.

Findings: none blocking.

Review notes:
1. Cursor consistency: for returned entries, the byte-offset cursor is sound when callers keep the same filters. The budget break path sets `nextCursor` to the overflowing entry offset (`server/src/search/search_logs.ts:99-104`), so that entry is re-read on the next page rather than skipped. The normal consumed-line path advances to `lineEnd` (`server/src/search/search_logs.ts:90-96,113-114`), so returned/filtered consumed lines are not duplicated.
2. Non-blocking cursor note: the current implementation does not actually emit an all-filtered-out page with `entries: []` plus `nextCursor`; if all remaining lines fail filters, it streams to EOF and omits `nextCursor`. That is acceptable for v1 behavior as implemented, but it means there is no empty-page resume token for polling a live run with no current matches.
3. Non-blocking metric note: in the response-budget lookahead path, `scanned` is incremented before discovering that the matching entry would overflow (`server/src/search/search_logs.ts:88-104`). The cursor offset is still correct, but `scanned` can over-count that lookahead line because the next page re-reads it. I would only patch this if `scanned` is intended as exact unique-line progress rather than telemetry.
4. Mark anchoring by `stat(logcat.jsonl).size` is acceptable for a coarse before/after window. The flushed-byte boundary is the right unit for this file-offset cursor; live-run imprecision around buffered appends is expected and preferable to comparing host-clock mark timestamps against device-clock logcat timestamps.
5. `resolveRunDir` scanning only the current runRoot is acceptable for v1. Active sessions are resolved from the manager first, so the cross-runRoot gap only affects historical runs after the deployment runRoot changes.
6. Crash signature parsing is robust enough for v1 because it is explicitly best-effort and nullable. Java/native/ANR paths are covered by fixture tests plus the real `am crash` probe; unusual tombstones can degrade to `mainException: null` / `topFrame: null` without losing the raw snippet.
7. `get_run_summary` with `readOnlyHint: true` is acceptable under the project G-8 matrix. The `summary.md` write is deterministic evidence materialization in the run folder, not a device/app mutation, and `stop_session` already performs the same best-effort materialization.
8. Error codes look OK: `invalid_cursor` and `mark_not_found` are branchable and specific; `invalid_argument` is fine for semantic range errors such as `crashIndex` beyond the crash count.

Verification run locally:
- `bun run typecheck`: pass
- `bun run lint`: pass, 100 files
- `bun run test -- server/tests/search/search_logs.test.ts server/tests/search/crash_context.test.ts server/tests/mcp/evidence.test.ts server/tests/summary/render.test.ts`: pass, 34 tests
- `bun run test`: pass, 34 files / 332 tests

---

## Disposition (本方)

Sign-off accepted with no code change. Notes 2 and 3 are deferred-with-note:

- **Note 2** (no empty-page resume token when every remaining line is filtered
  out) — accepted as v1 behavior. `nextCursor` is omitted at EOF; an agent
  polling a live run for not-yet-present matches re-issues the search rather
  than holding a resume token. Revisit only if live-tail polling becomes a
  first-class use case.
- **Note 3** (`scanned` over-counts the lookahead line by 1 at a budget break)
  — no patch. `scanned` is documented as telemetry / sanity only
  (`search/cursor.ts`, `SearchResult.scanned`), not exact unique-line progress;
  the cursor `offset` — which IS load-bearing — is exact. Codex's own condition
  ("only patch if `scanned` is exact progress") is not met.

Notes 4-8 confirm the design decisions as taken; no action.
