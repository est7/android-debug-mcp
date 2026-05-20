# Phase 10 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-10`
**Outcome:** **patch-required** (1 P1 — public tool descriptions under-documented the new `adb_command_failed` envelope)
**Source message id:** `2026-05-20T13-57-57.301Z_pid49184_3c2ed544`

---

## Codex reply (verbatim)

patch-required

P1 — Public tool descriptions still under-document the new `adb_command_failed` domain envelope.

Evidence:
- `server/src/mcp/register.ts:120-129` now maps every `AdbError` subclass into `{isError:true, content:[{text: JSON.stringify({error, message})}]}`.
- `server/src/mcp/toolError.ts:33-34` includes both `adb_not_found` and `adb_command_failed` in the branchable tool-error catalog.
- Several public `Errors:` lines still omit `adb_command_failed` even though the handler can now return it. Examples:
  - `server/src/mcp/tools/tap.ts:25` documents only `no_active_session` / `device_disconnected`, but `tap.ts:48` calls `inputTap`, which uses `runAdb` and can throw `AdbExecError("adb_command_failed")`.
  - `server/src/mcp/tools/app_control.ts:31` documents only session/disconnect + launch-detail behavior, but `app_control.ts:58,64,70,78` call adb-backed helpers that can throw `AdbExecError` outside the documented launch-failure-as-detail path.
  - `server/src/mcp/tools/capture.ts:52` says a screenshot that returns no PNG throws, but after Phase 10 that throw is a branchable `adb_command_failed` envelope, not a protocol throw.
  - `server/src/mcp/tools/start_session.ts:58` omits `adb_not_found` / `adb_command_failed`, but `start_session.ts:84,85,129,138,143,162` can reach adb-backed resolution, logcat clear, launch, pid, and logcat spawn paths.
- `android_debug_list_devices` is closer, but `server/src/mcp/tools/list_devices.ts:42` still says "throws `adb_not_found`". With the Phase 10 wrapper, this should be described as a returned domain error envelope, not a raw throw/protocol error.

Why blocking:
Tool descriptions are the client-visible contract. If `adb_command_failed` is intentionally universal infrastructure, clients still need a visible way to know that a tool call may branch on it. The current runtime is stricter/better, but the advertised per-tool `Errors:` contract remains inconsistent with the new observable shape.

Requested patch:
Update the `Errors:` descriptions for every adb-touching tool to include `adb_command_failed` where an adb subprocess failure can surface. Also reword `list_devices` from "throws `adb_not_found`" to the same domain-envelope language used elsewhere. I would also add/extend a contract test over `client.listTools()` descriptions so adb-backed tools cannot regress by omitting `adb_command_failed` after the Phase 10 catalog hardening.

Review asks:
1. Catalog pruning: agree. `rg 'app_control_failed|clear_blocked_by_active_session' server/src server/tests` shows no remaining reachable references; TypeScript would catch direct `ToolErrorCode` use.
2. Uniform `AdbError` mapping: agree. `AdbExecError` is explicitly an adb-layer failure, including timeout/maxBuffer/shell non-zero cases. Non-Adb unexpected bugs still rethrow as protocol errors.
3. Phase 9 disconnect window: acceptable for v1. Returning `adb_command_failed` until the next health poll is honest and avoids brittle stderr-sniffing. A later targeted mapper for well-known offline strings can be added with fixtures if product needs that UX.
4. Per-tool descriptions: not acceptable as-is; this is the blocking item above.

Verification performed:
- `git diff --check` — passed, no output.
- `bun run typecheck` — passed.
- `bun run lint` — passed: `Checked 110 files in 26ms. No fixes applied.`
- `bun run test` — passed: 39 files / 372 tests.

Non-blocking commit hygiene note:
`git status --short` also shows untracked `android-debug-tools/` alongside the intended untracked `server/tests/integration/`. `android-debug-tools/` is not mentioned in the Phase 10 change list and is excluded from tsconfig/vitest/biome, so keep it out of the Phase 10 commit unless it is a separate intentional artifact.

---

## Patch (本方接受)

The 10 adb-touching tools' `Errors:` description lines now document
`adb_command_failed` (and `adb_not_found` for `list_devices` / `start_session`,
the only tools that can reach an unresolved adb binary). `list_devices` is
reworded from "throws `adb_not_found`" to the domain-envelope language used
elsewhere. The 7 non-adb tools are unchanged. A new contract test in
`tests/integration/tool_contract.test.ts` asserts every tool in
`ADB_TOUCHING_TOOLS` carries `adb_command_failed` in its `listTools()`
description, so an adb-backed tool cannot silently regress. Verify: 373/373.

---

# Phase 10 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-10`
**Outcome:** **sign-off** — Phase 10 cleared to commit and proceed to Phase 11.
**Source message id:** `2026-05-20T14-02-52.303Z_pid54949_c32883cb`

---

## Codex reply (verbatim)

sign-off

Re-reviewed the Phase 10 P1 patch against current files. The prior blocker is resolved.

Evidence:
- All 10 adb-touching tools now document `adb_command_failed` in their public `Errors:` descriptions: `list_devices`, `start_session`, `app_control`, `clear_app_data`, `get_app_state`, `tap`, `input_text`, `send_key`, `swipe`, `capture`.
- `server/src/mcp/tools/list_devices.ts` no longer says raw "throws `adb_not_found`"; it now states `adb_not_found` / `adb_command_failed` are returned as the domain envelope (`isError:true`), not raised as protocol errors.
- `server/tests/integration/tool_contract.test.ts` now has `ADB_TOUCHING_TOOLS` with exactly those 10 tools and asserts every listed tool description contains `adb_command_failed`. I cross-checked the set against actual adb subprocess reachability via the tool handlers and adb helper calls; the 7 non-adb tools are correctly excluded.
- The original Phase 10 runtime path remains correct: `wrapToolHandler` maps `AdbError` to the branchable envelope and still rethrows non-domain / non-adb bugs as protocol errors.

Verification performed:
- `git diff --check` — passed, no output.
- `bun run typecheck` — passed.
- `bun run lint` — passed: `Checked 110 files in 28ms. No fixes applied.`
- `bun run test` — passed: 39 files / 373 tests.

Notes:
- The older resend message in this thread is superseded by this re-review; no separate duplicated verdict needed.
- Non-blocking hygiene remains unchanged: keep untracked `android-debug-tools/` out of the Phase 10 commit unless it is intentionally included separately.
