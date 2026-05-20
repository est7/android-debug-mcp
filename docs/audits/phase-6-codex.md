# Phase 6 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-6`
**Outcome:** **patch-required** (1 P1 — base64 command literal smuggles `Authorization:` / `Cookie:` secrets past the generic redaction pass)
**Source message id:** `2026-05-20T07-23-14.340Z_pid56046_7007bea5`

---

## Codex reply (verbatim)

patch-required

Findings

1. [P1] `server/src/mcp/tools/input_text.ts:96-108` — `input_text` decides whether to placeholder the command payload using only `input.sensitive === true || redactInputText(input.text).redacted`. That misses Phase-5 string-content secrets such as `Authorization:` and `Cookie:`. Because `commands.jsonl` records a base64 broadcast literal, the later generic `appendCommand -> redactValue -> redactString` pass cannot see or redact the decoded text. Result: a value that Phase 5 would redact in clear text can still land in `commands.jsonl` as trivially decodable base64.

   Direct probe against the current code shape:
   ```json
   {"text":"Authorization: Basic dXNlcjpwYXNz","redactedPlain":"Authorization: ***","isSecret":false,"rawB64":"QXV0aG9yaXphdGlvbjogQmFzaWMgZFhObGNqcHdZWE56","command":{"tool":"input_text","adb":"am broadcast -a ADB_INPUT_B64 --es msg QXV0aG9yaXphdGlvbjogQmFzaWMgZFhObGNqcHdZWE56","redacted":false}}
   {"text":"Authorization: Digest username=alice, response=secret","redactedPlain":"Authorization: ***","isSecret":false,"rawB64":"QXV0aG9yaXphdGlvbjogRGlnZXN0IHVzZXJuYW1lPWFsaWNlLCByZXNwb25zZT1zZWNyZXQ=","command":{"tool":"input_text","adb":"am broadcast -a ADB_INPUT_B64 --es msg QXV0aG9yaXphdGlvbjogRGlnZXN0IHVzZXJuYW1lPWFsaWNlLCByZXNwb25zZT1zZWNyZXQ=","redacted":false}}
   {"text":"Cookie: sid=secret; theme=dark","redactedPlain":"Cookie: ***","isSecret":false,"rawB64":"Q29va2llOiBzaWQ9c2VjcmV0OyB0aGVtZT1kYXJr","command":{"tool":"input_text","adb":"am broadcast -a ADB_INPUT_B64 --es msg Q29va2llOiBzaWQ9c2VjcmV0OyB0aGVtZT1kYXJr","redacted":false}}
   ```

   Patch request: make the `input_text` placeholder decision include the Phase-5 string matcher before base64 encoding, e.g. `redactString(input.text) !== input.text` (or an equivalent helper that says whether `redactValue` would alter this text). Then `recordedText` should be `***<len>` whenever explicit `sensitive`, the input_text heuristic, or embedded credential redaction fires. Add regression tests that assert both `commands.jsonl` and `events.jsonl` contain neither the raw Authorization/Cookie string nor `encodeInputB64(rawText)` when `sensitive` is omitted.

Answers to specific review asks
- ADBKeyBoard auto-switch: acceptable for v1. The tool is explicitly an interaction driver; auto-selecting the required IME plus `input_method_unavailable` on failed verification is a better operational contract than making every caller preconfigure the device.
- IME restore: accept for Phase 6, but track as follow-up. Leaving the device on ADBKeyBoard is stateful and visible, but not a correctness blocker for the capture/interaction slice if documented.
- `input_text` command/event split: acceptable only after finding #1 is fixed. Base64 is fine as an audit literal if it is base64 of the placeholder whenever any Phase-5 matcher would redact the real text.
- `capture` command record without `adb`: acceptable for v1. It runs a multi-command workflow and records `captureId` / artifacts; adding a compact step list can be backlog, not a blocker.
- Redaction Phase-5 gate: not confirmed; finding #1 is a counterexample. The gate holds for explicit `sensitive:true`, `password`/`token`/`otp`/`verification` heuristic hits, but not for `Authorization` / `Cookie` text.
- `captureUiDump` null vs screenshot throw: acceptable asymmetry. Screenshot is the primary binary artifact and should fail hard on corruption; UI dump being optional/null preserves screenshot value on flaky uiautomator.
- Artifact filename safety: accepted. `captureId` is 12 hex chars from `randomBytes(6)` and filenames are not caller-controlled.

Verification performed
- `bun run typecheck`: pass (exit 0)
- `bun run lint`: pass, 84 files checked
- `bun run test`: pass, 29 files / 289 tests
- Direct Bun probes above confirmed the base64 command-stream leak for Authorization/Cookie input_text values.

Sign-off: patch-required. The blocker is narrow: fix the `input_text` placeholder decision before base64 command recording, then rerun the same gates plus targeted encoded-secret regressions.

---

## Patch (本方接受)

The base64 command literal hides the `Authorization:` / `Cookie:` keywords from
the generic `appendCommand` → `redactValue` → `redactString` pass — a regression
introduced by the ADBKeyBoard pivot (the pre-pivot `input text <escaped>` form
kept the keyword visible, so the generic pass caught it).

- `server/src/mcp/tools/input_text.ts` — the `isSecret` decision now also fires
  on the embedded-credential matcher. `input.text` is a bare string, so
  `redactValue` on it reduces exactly to `redactString`; the three terms
  together cover every redaction layer:

  ```ts
  const isSecret =
    input.sensitive === true ||
    redactInputText(input.text).redacted ||
    redactString(input.text) !== input.text;
  ```

  When `isSecret`, `recordedText = ***<len>`; when not, `redactString(text) === text`
  is proven, so the plaintext (and its base64) is genuinely clean in both streams.
- `server/tests/mcp/interaction.test.ts` — added a parametrized regression
  (Authorization Basic / Cookie): with `sensitive` omitted, neither `events.jsonl`
  nor `commands.jsonl` contains the raw credential, the secret fragment, or
  `base64(rawText)`; the event records `text: ***<len>`, `redacted: true`.

## Verify (post-patch)

- `bun run typecheck` ✅ / `bun run lint` ✅ 84 files / `bun run test` ✅ **291/291**.

---

# Phase 6 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-6`
**Outcome:** **sign-off** — Phase 6 cleared to commit and proceed to Phase 7.
**Source message id:** `2026-05-20T07-31-25.234Z_pid63129_bf303739`

---

## Codex reply (verbatim)

Sign-off: P1 patch accepted. No new blocking findings.

Review notes:
- `server/src/mcp/tools/input_text.ts:101-115` now treats embedded-credential matches from `redactString(input.text)` as secret before constructing the recorded command. That closes the previous base64 smuggling path because `appendCommand` only sees `encodeInputB64(recordedText)`, not `encodeInputB64(input.text)`.
- `server/tests/mcp/interaction.test.ts:328-352` covers the previously missed Authorization/Cookie cases with `sensitive` omitted and asserts absence of raw text, secret fragments, and `base64(rawText)` in both `events.jsonl` and `commands.jsonl`.
- I also checked the ADB layer: production `runAdb` does not persist args; durable recording for this tool remains through `appendCommand` / `appendEvent`.

Verification run locally:
- `bun run typecheck`: pass
- `bun run lint`: pass, 84 files
- `bun run test -- server/tests/mcp/interaction.test.ts`: pass, 13 tests
- `bun run test`: pass, 29 files / 291 tests

Non-blocking note: `bun test server/tests/mcp/interaction.test.ts` fails before tests because Bun test does not provide Vitest `vi.hoisted`; the project script (`bun run test`, i.e. `vitest run`) is the correct runner.

---

## Deferred / follow-up (codex-accepted, non-blocking)

- **IME restore** — `input_text` leaves the device on ADBKeyBoard after a run;
  restoring the previous IME at `end_session` is tracked as a follow-up.
- **`capture` command record** — records `{tool, captureId, kinds}` with no
  literal `adb`; a compact step list is backlog, not a blocker.
