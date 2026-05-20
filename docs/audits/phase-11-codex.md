# Phase 11 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-11`
**Outcome:** **patch-required** (1 P1 — README misstated the error transport contract; 1 P2 — test-plan Scenario B missing a step)
**Source message id:** `2026-05-20T14-20-45.503Z_pid70269_82c5eb94`

---

## Codex reply (verbatim)

patch-required

P1 — README still misstates the Phase 10 error transport contract.

Evidence:
- `README.md:81-83` says: every tool is named `android_debug_*` and returns `structuredContent`; recoverable failures come back as `{ isError: true }` with `{error, message}`.
- The actual transport contract is success-only `structuredContent`. `server/src/mcp/register.ts:83-89` says success returns `{content, structuredContent}`, but `ToolDomainError` returns `{content:[text], isError:true}` with NO `structuredContent`.
- Tests assert the same: `server/tests/mcp/register.test.ts:141-147` expects a domain error to have `structuredContent === undefined`; `server/tests/mcp/register.test.ts:155-161` expects the same for `AdbError`; `server/tests/integration/tool_contract.test.ts:128-132` enforces it for tool calls.

Why blocking:
Phase 11 is the user-facing contract doc, and Phase 10 specifically hardened error-shape consistency. A host/client author following the README would look for `structuredContent` even on branchable failures, which is exactly the shape the runtime intentionally does not provide.

Requested patch:
Reword the README contract paragraph to distinguish success and error results, e.g. "On success, tools return `structuredContent`; recoverable failures return `{isError:true}` and put the JSON `{error,message,...}` payload in `content[0].text`, with no `structuredContent`."

P2 — Manual test-plan Scenario B has a missing step for one of its pass boxes.

Evidence:
- `docs/test-plan.md:44-47` steps start, crash, extract, then stop.
- `docs/test-plan.md:52-53` asks the tester to verify `get_run_summary` shows the crash / `crashFound:true`, but the scenario never instructs them to call `android_debug_get_run_summary { runId }`.

Suggested patch:
Add `android_debug_get_run_summary { runId }` after `stop_session` in Scenario B, or remove that pass box. This is lower severity because an experienced tester can infer it, but it weakens the checklist as a release gate.

Non-blocking stale index note:
- `docs/README.md:3` still says `server/` is not established, which is stale now that the repo has a full `server/src` tree. Not blocking Phase 11 quickstart correctness, but worth refreshing with the docs index touch.

Review ask answers:
1. 5-minute quickstart: mostly yes after the P1 wording fix. Install + host config + `start_session` path is present.
2. `ANDROID_DEBUG_MCP_RUN_ROOT`: matches `resolveRunRoot()` ordering and run folder layout.
3. Scenario payload schemas: README payload fields match current input schemas for the five scenarios I checked.
4. MCP host command: `command: "bun"`, `args: ["<abs>/server/src/server.ts"]` matches the package entrypoint. I also checked `claude mcp add --help`; the stdio shape is consistent with invoking `bun <abs>/server/src/server.ts` and setting env via `--env` / `-e`.

Verification performed:
- `git diff --check` — passed, no output.
- `bun run typecheck && bun run lint && bun run test` — passed; lint checked 110 files, test passed 39 files / 373 tests.

---

## Patch (本方接受)

- `README.md` — the "The 17 tools" paragraph now states success returns
  `structuredContent`, while a recoverable failure returns `{isError:true}`
  with the JSON payload in `content[0].text` and **no** `structuredContent`.
- `docs/test-plan.md` — Scenario B gains step 5,
  `android_debug_get_run_summary { runId }`.
- `docs/README.md` (non-blocking note) — the stale "`server/`(暂未建立)"
  wording is removed; the `test-plan.md` row is updated with a live link; an
  `audits/` row is added so the index covers the per-phase audit reports.

---

# Phase 11 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-11`
**Outcome:** **sign-off** — Phase 11 cleared to commit and proceed to Phase 12.
**Source message id:** `2026-05-20T14-23-55.658Z_pid74832_b22ef600`

---

## Codex reply (verbatim)

SIGN-OFF

Re-review scope: Phase 11 P1 + P2 patched items, plus the non-blocking docs index note from the request.

Checks performed:
- README.md: the "The 17 tools" paragraph now distinguishes success structuredContent from recoverable failure { isError: true } with JSON payload in content[0].text and no structuredContent. This matches server/src/mcp/register.ts wrapToolHandler behavior.
- server/tests/mcp/register.test.ts: success/domain/ADB error transport assertions cover the same contract, including no structuredContent for ToolDomainError and AdbError.
- server/tests/integration/tool_contract.test.ts: unknown runId cases assert domain error results and no structuredContent across the run-scoped tools.
- docs/test-plan.md: Scenario B now has step 5 android_debug_get_run_summary { runId }, so the pass box checking the Crashes section / crashFound:true has an explicit preceding action.
- docs/README.md: stale "server/ 暂未建立" wording is gone; test-plan.md is a live link; audits/ is indexed and the directory exists.

Verification run:
- bun run test -> 39 files passed, 373 tests passed.

Verdict: SIGN-OFF. No remaining P1/P2 blocker found in this re-review scope.
