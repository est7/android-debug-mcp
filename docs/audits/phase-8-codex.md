# Phase 8 — Codex audit (plan review + implementation review)

Phase 8 went through a pre-implementation plan review and a two-round
implementation gate. Final outcome: **sign-off**.

---

# Round 1 — plan review

**Date:** 2026-05-20
**Thread:** `review/phase-8`
**Outcome:** **change-request** (3 adjustments before building)
**Source message id:** `2026-05-20T08-33-34.729Z_pid12249_ddc375ee`

## Codex reply (verbatim)

Plan review outcome: change-request before implementation. The shape is good, but I would adjust three points before building.

Findings / change requests:

1. P1 security: `collect_bundle(logs:"raw")` needs the explicit acknowledgement from the spec. `docs/decision-amendments.md:107-109` says `logs` replaces `includeRaw`, default is `none`, `redacted` writes a temporary redacted logcat jsonl, and `raw` requires `acknowledgeUnredacted: true` or reject. Your `collect_bundle {runId, logs?}` contract omits that ack, which weakens the C-4 leak gate. Keep `redacted = actually redact logcat.jsonl at bundle time`; do not reinterpret it as merely "jsonl included, raw excluded".

2. P1 correctness: stale-lock cleanup must be owner-guarded, not a blind final `unlink`. `lock.ts` already documents the TOCTOU risk around stale lock eviction and protects normal release by comparing the current owner before unlinking. Phase 8 recovery has the same global-lock race: another process can evict/reacquire the tuple lock while recovery is replaying, and a late `unlink(<tuple>.lock)` would delete a live successor's lock. Add/export a helper like `releaseLockIfOwner(path, expectedOwner)` or claim the lock with a recovery owner and release that handle. Also use the same liveness semantics as `lock.ts` (`pid alive` plus `processStartMs` when present; absence of start-time evidence means treat as live), not a weaker pid-only check.

3. P2 evidence completeness: for orphan `replayParse`, I would not use `appUid=null + knownPids harvested from partial logcat.jsonl` as the default filter. `metadata.json` currently has no appUid field (`server/src/store/metadata.ts:20-32`), and `replayParse` applies `shouldKeep` before writing rebuilt `logcat.jsonl` (`server/src/logcat/recovery.ts:57-59`). If the original derived channel failed early or filtered out the relevant Start proc / app lines, the rebuilt structured log will be permanently thinner than the raw truth. For recovery, prefer a conservative "keep all parsed entries when appUid is unavailable" mode, or persist appUid during normal start for future runs and fall back to keep-all for old runs. Crash detection already scans raw, but `search_logs` and `get_run_summary` quality depend on `logcat.jsonl`.

Open decision reads:

1. `logs` semantics: choose your first reading. `none` default omits both logcat files; `redacted` includes a bundle-time redacted logcat jsonl and excludes raw; `raw` includes verbatim logcat jsonl + raw only with `acknowledgeUnredacted:true`.
2. Recovery `FilterContext`: keep all parsed lines when there is no reliable appUid. If you later add `appUid` to metadata, use normal filtering for runs that have it.
3. Failed single-orphan recovery: do not add a 5th `RunStatus` for v1. The 4-value enum is already wired through session/status schemas. Leaving `closedAt:null` to retry next boot is acceptable, but make sure the failure is visible in logs and, if cheap, a small recovery-error sidecar; do not silently make `list_runs` look like a healthy active run without indicating recovery failed.

Other plan points accepted:
- `bootstrap(): register tools -> recover -> connect transport` satisfies "recovery before serving".
- Same-tuple ascending `startedAt` and cross-tuple default serial is fine.
- `list_runs` cursor `{lastStartedAt,lastRunId}` is sound for `startedAt DESC, runId DESC`; include the documented identity/root fields in each run (`runRoot`, `deviceSerial`, `userId`, `packageName`, status/closedAt) so callers do not have to rediscover ownership.
- `collect_bundle` via staging dir + `tar -czf` is fine; keep bundle output outside the staged input tree and avoid including the generated tar inside itself.

## Disposition

All 3 change-requests folded into the build: `acknowledgeUnredacted` on
`collect_bundle` (raw without it → `confirmation_required`); `releaseLockIfOwner`
+ `isLockOwnerLive` exported from `lock.ts` and used by recovery; `replayParse`
`filter` made optional → recovery runs keep-all. Open-decision reads 1-3 all
followed; `replayParse` failure inside recovery made non-fatal so a dead run is
still finalized `aborted` (never a healthy-looking `active`).

---

# Round 2 — implementation review

**Date:** 2026-05-20
**Thread:** `review/phase-8`
**Outcome:** **patch-required** (1 P1 — recovery masked unreadable lock owners as "no lock")
**Source message id:** `2026-05-20T08-55-19.856Z_pid31080_4efa8d3d`

## Codex reply (verbatim)

Patch-required: one recovery safety issue. The three plan-review requests are mostly incorporated, but the orphan scan now masks unreadable/corrupt lock owners as "no lock".

Finding:

1. P1 — `server/src/recovery/scan.ts:70-81`: `const owner = await readLockOwner(lockPath).catch(() => null);` collapses every lock-read failure into the C-5 "lock absent" case. `readLockOwner` only returns `null` for ENOENT and otherwise throws on unreadable / malformed owner JSON (`server/src/store/lock.ts:206-215`). By catching all errors here, recovery can finalize a run as `aborted` even though a lock file exists and recovery has not proven the owner is stale or absent. That breaks the C-5 safety invariant: lock present but owner unknown must not be treated like lock absent. In the worst case another process is still writing the run while this bootstrap replays/truncates derived logs and patches metadata. It can also leave a corrupt lock behind while `list_runs` shows the run closed, so the tuple remains blocked later by `acquireLock`.

Patch ask:
- Do not catch all around `readLockOwner` in `recoverOne`.
- Treat unreadable/malformed lock owner as `recovery_failed` or a dedicated blocked outcome, leave metadata unchanged, and log the lock read error. Only `owner === null` from ENOENT should enter the no-lock finalize path.
- Add a regression test with a present corrupt lock file: recovery must not patch `closedAt/status`, must not truncate/replay logs, and must report a non-recovered outcome.

Other review notes:
- `collect_bundle` raw ack gate is implemented correctly: `logs:"raw"` without `acknowledgeUnredacted:true` returns `confirmation_required`; `redacted` emits `logcat.redacted.jsonl` and removes raw/unredacted logcat from the staged copy.
- `releaseLockIfOwner` is the right owner-guarded primitive for stale locks when the owner was successfully parsed.
- `replayParse` optional filter / recovery keep-all is the right conservative choice for v1.
- Recovery only scanning current `resolveRunRoot()` is acceptable for v1, same limitation as Phase 7 `resolveRunDir`.
- Best-effort bootstrap recovery is the right call; server availability should win, with unrecovered runs retried next boot.
- Staging-copy bundle creation and full metadata scan for `list_runs` are acceptable v1 tradeoffs.

## Patch (本方接受)

`recoverOne` no longer catches all errors around `readLockOwner`. A throw
(unreadable / malformed JSON) → `recovery_failed`, metadata untouched, error
logged. A `null` return is disambiguated with `pathExists(lockPath)`: a present
file with no valid owner is also `recovery_failed`; only a genuine ENOENT
reaches the no-lock finalize path. Regression test added: a present corrupt
lock file → `recovery_failed`, metadata still `active` / `closedAt:null`,
`logcat.jsonl` sentinel untouched (no replay / truncate). Verify: 348/348.

---

# Round 3 — sign-off

**Date:** 2026-05-20
**Thread:** `review/phase-8`
**Outcome:** **sign-off** — Phase 8 cleared to commit. v1 tool inventory (17) complete.
**Source message id:** `2026-05-20T09-00-04.464Z_pid39287_58112505`

## Codex reply (verbatim)

Sign-off: P1 patch accepted. No new blocking findings.

Review notes:
- `server/src/recovery/scan.ts` now preserves the C-5 invariant: only a genuinely absent lock reaches the no-lock finalize path. `readLockOwner` errors return `recovery_failed`, and `owner === null` is disambiguated with `pathExists(lockPath)` before recovery proceeds.
- The added `pathExists` check is conservatively safe for the race I cared about: if `readLockOwner` sees ENOENT but a new lock appears before the check, recovery blocks instead of finalizing.
- The corrupt-lock regression covers the key failure mode: present unreadable lock -> `recovery_failed`, metadata still `active` / `closedAt:null`, and `logcat.jsonl` sentinel untouched (no replay/truncate).

Verification run locally:
- `bun run typecheck`: pass
- `bun run lint`: pass, 108 files
- `bun run test -- server/tests/recovery/scan.test.ts`: pass, 7 tests
- `bun run test`: pass, 37 files / 348 tests

Remaining accepted v1 tradeoffs unchanged: current-runRoot recovery scope, best-effort bootstrap, staging-copy bundle, and full metadata scan in `list_runs`.
