# Phase 4 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-4`
**Outcome:** **patch-required** (3 P1 + 1 P2)
**Source message id:** `2026-05-20T03-46-28.547Z_pid5737_26ef9b98`

> Codex blocker summary: "the raw truth channel can still be lost or truncated by downstream derived-channel failures, which breaks the core dual-channel safety property."

---

## Findings

### P1

- **[P4-P1-1] Raw channel not isolated from derived-pipeline failures.** `worker.ts` + `channel.ts:153` — `RawWriter.write` only queues bytes; durability is the later flush/close. If `logcatStream.append` / `crashStream.append` / `emitEvent` rejects, the worker's promise chain rejects; subsequent `onChunk()` calls chain onto a rejected promise and never run `process()`, so future chunks are not even byte-teed to raw. At shutdown, `await worker.finish()` rejects before `rawWriter.close()`, leaving queued raw bytes unflushed. Codex reproduced both: derived append failure → `raw bytes 0`; and a derived failure on chunk 1 → chunk 2's `third` never reaches raw.
  **Patch:** raw tee must be independent + fail-closed only for raw IO itself. `LogcatChannel.shutdown()` must close the raw writer in a `finally` even when `worker.finish()` fails; `LogcatWorker` must not let derived failures poison the chain. Regression tests for derived-append-failure preserving raw + continuing to tee.

- **[P4-P1-2] `waitForClose` short-circuits on `exitCode`/`signalCode`.** `channel.ts:168` — Node's `close` event (stdio EOF) is the real "stdout drained" signal; `exit` can fire while stdout still has buffered data. Treating `exitCode/signalCode` as drained can run `worker.finish()` + `rawWriter.close()` before the last `data` events, losing late chunks.
  **Patch:** explicit `closed` flag from the child `close` event; wait for it. Test with a fake child emitting `exit` before `close` + a late chunk.

- **[P4-P1-3] Partial `LogcatChannel.start()` failure leaks resources.** `channel.ts:62-78` — `tracker.start()` runs before `startLogcat()` with no try/finally. If `startLogcat()` throws, the pid-poll timer leaks; if `RawWriter.open()` / anchor write fails after the adb child spawned, the child leaks. `Session.startLogcat()` assigns `this.logcat` only after `start()` resolves, so `manager.abort` has no handle to the partials.
  **Patch:** wrap startup so every failure path stops the tracker, kills/waits the child, closes any opened RawWriter. Tests for `startLogcat` throwing after tracker start + raw-writer-open failure after child spawn.

### P2

- **[P4-P2-4] `proc.startsWith(packageName)` overmatches sibling packages.** `process_tracker.ts:75` — a session for `com.foo` would accept `Start proc …:com.foobar/…` and keep that foreign pid forever (grow-only set), polluting `logcat.jsonl`.
  **Patch:** `proc === packageName || proc.startsWith(packageName + ":")`. Tests for default process, `:remote`, and a sibling-prefix package.

## Codex answers to open decisions

- Byte tee ordering directionally right, **not sufficient** until raw IO is isolated (#1).
- `close` is the right signal, but impl still short-circuits (#2).
- Grow-only knownPids OK once package match is exact-or-colon (#4).
- `truncatedSuspect` false positives acceptable (noisy annotation).
- Numeric uid degradation acceptable for v1; note `dumpsys package userId=` is often the appId, not the full Linux uid — secondary Android users may need explicit validation later.
- Dropping `severity ≥ W` deferrable since raw keeps everything + crash scan is raw-side — **must be documented as a structured-view tradeoff**.
- Unbounded chunk promise-chain backpressure: deferred risk, revisit after #1.
- `-T <epoch>` skew fallback deferrable with the raw `session_start` anchor.
- `recovery.replayParse` placeholder `rawByteCount` acceptable while Phase 8 is unwired.

## Codex verification

- `bun run typecheck` ✅ / `bun run lint` ✅ 70 files / `bun run test` ✅ 23 files / 220 tests
- Direct Bun probes reproduced derived-append-failure preventing raw flush + poisoning future raw byte-tee.

## Patch plan (本方接受)

1. **[P4-P1-1]** `LogcatWorker`: move `rawWriter.write(chunk)` to a synchronous, unconditional first step in `onChunk` (outside the promise chain); chain the derived pipeline with an internal `.catch` so it never stays rejected; `handleLine` / `flushPending` swallow + count derived errors (`derivedErrors` in stats); `finish()` never rejects from derived failures. `LogcatChannel.shutdown()` closes `rawWriter` in a `finally`.
2. **[P4-P1-2]** `LogcatChannel`: `private childClosed` flag set by a `close` listener registered at `start()`; `waitForClose` waits on that flag, not `exitCode/signalCode`; `shutdown` gates SIGTERM on `!childClosed`.
3. **[P4-P1-3]** `LogcatChannel.start()`: try/catch around resource acquisition — on any failure stop tracker, SIGKILL+forget child, close opened RawWriter, rethrow.
4. **[P4-P2-4]** `process_tracker.observeSystemLine`: exact-or-colon package match.
5. Tests for each + document the `severity ≥ W` structured-view tradeoff in `filter.ts`.

---

# Phase 4 — Patch round 1

**Date:** 2026-05-20

## Applied

- **[P4-P1-1]** `LogcatWorker` — `rawWriter.write(chunk)` is now a synchronous, unconditional first step in `onChunk`, OUTSIDE the promise chain; the chain has an internal `.catch` so a rejection never poisons it; `handleLine` advances the raw counters unconditionally then runs derived work in try/catch; `flushPending` / `emitSafely` swallow + count `derivedErrors`; `finish()` never rejects from derived failures. `LogcatChannel.shutdown()` closes the raw writer in a `finally`.
- **[P4-P1-2]** `LogcatChannel` — `childClosed` flag set by a `close` listener wired at `start()`; `waitForClose` waits on that flag (not `exitCode/signalCode`); `shutdown` gates SIGTERM on `!childClosed`.
- **[P4-P1-3]** `LogcatChannel.start()` — resource acquisition wrapped in try/catch; on any failure it stops the tracker, SIGKILLs the spawned child, closes any opened RawWriter, then rethrows. `start_session`'s existing abort path therefore never strands a partial channel.
- **[P4-P2-4]** `ProcessTracker.observeSystemLine` — exact-or-`:` package match (`proc === pkg || proc.startsWith(pkg + ":")`); a sibling package like `com.foobar` no longer matches `com.foo`.
- `filter.ts` doc updated: the dropped `severity ≥ W` clause is documented as a structured-view tradeoff (raw keeps everything; crash scan is raw-side).

## Tests added (233 total, was 220)

- `worker.test.ts` — derived-append failure: raw still byte-tee'd for that and *subsequent* chunks; `finish()` does not reject; `derivedErrors` counted; happy path; crash scan on a filter-dropped line.
- `channel.test.ts` — shutdown waits for `close` not `exit` (fake child emits `exit` + a late chunk, then `close`); `startLogcat` failure stops the tracker; `RawWriter.open` failure kills the spawned child; clean shutdown reports stats.
- `process_tracker.test.ts` — default process / `:remote` / sibling-prefix non-match / seed-pid retention.

## Verify

- `bun run typecheck` ✅ / `bun run lint` ✅ 73 files / `bun run test` ✅ **233/233** — all gates re-run after the final edit.
- Real-device probe re-run (`951a20a2`, `com.android.settings`): raw 208 KB, jsonl 462 lines, linesParsed 1667, clean SIGTERM (`killed false`).

---

# Phase 4 — Codex audit reply (round 2)

**Date:** 2026-05-20
**Thread:** `review/phase-4`
**Outcome:** **patch-required** (1 new P2 — `rawByteCount` flush-time binding)
**Source message id:** `2026-05-20T04-00-51.021Z_pid19153_07853c18` (the first delivery arrived with an empty body; codex resent)

Round-1's four findings (P4-P1-1/2/3, P4-P2-4) all **accepted**. Dual-channel safety property: **sign-off**.

## New finding

- **[P4-R2-P2] `logcat.jsonl.rawByteCount` is bound to flush time.** `worker.ts` — `PendingEntry` stored `rawLineNo` but not a byte offset; `flushPending` wrote the *global* `rawByteCount`, which the next entry's header line had already advanced. Codex probe: two kept 53-byte lines in one chunk both got `rawByteCount: 106` — entry 1 pointed past entry 2. This is live Phase-4 output (distinct from the accepted Phase-8 `replayParse` placeholder).
  **Patch:** capture the entry's end byte count at creation; extend it per continuation line; write `entry.endByteCount`.

## Codex verification

- `bun run typecheck` / `lint` (73 files) / `test` (26 files / 233) all pass.
- Direct Bun probe confirmed the live `rawByteCount` mismatch.

# Phase 4 — Patch round 2

- `worker.ts` — `PendingEntry` gains a mutable `endByteCount`, set to the cumulative `rawByteCount` when the entry's header line is processed and extended each time a continuation line is merged. `flushPending` writes `entry.endByteCount`, not the global counter.
- `worker.test.ts` — regression: two kept entries in one chunk → entry 1's `rawByteCount === Buffer.byteLength(line1)`, entry 2's `=== byteLength(line1)+byteLength(line2)`.
- Verify: `typecheck` ✅ / `lint` ✅ 73 files / `test` ✅ **234/234**.

---

# Phase 4 — Codex audit reply (round 3 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-4`
**Outcome:** **sign-off** — Phase 4 cleared to commit and proceed to Phase 5.
**Source message id:** `2026-05-20T04-04-50.670Z_pid25298_c4a6df35`

## Codex verification (round 3)

- `bun run typecheck` ✅ / `bun run lint` ✅ 73 files / `bun run test` ✅ 26 files / 234 tests
- Direct Bun probe — two 53-byte entries + one 37-byte continuation → `rawByteCount` 53 (entry 1) and 143 (entry 2), each matching its own raw span (including the merged continuation).

## Outcome

- Round-1 four findings (P4-P1-1/2/3, P4-P2-4): accepted.
- Dual-channel safety property: sign-off.
- Round-2 `rawByteCount` blocker: fixed.
- **Phase 4 commit sign-off.**

## Deferred items carried forward (codex-accepted)

- Chunk promise-chain backpressure bound — revisit if a logcat flood + slow appends becomes real.
- `-T <epoch>` host/device clock-skew fallback (parser-side `parsedTs < started_at` drop) — the raw `--- session_start ---` anchor covers v1.
- `recovery.replayParse` per-line `rawByteCount` reconstruction — Phase 8 when orphan recovery is wired.
