# Phase 5 — Codex audit reply (round 1)

**Date:** 2026-05-20
**Thread:** `review/phase-5`
**Outcome:** **patch-required** (2 P1 — suffix leaks in header / quoted-value redaction)
**Source message id:** `2026-05-20T04-13-43.698Z_pid33495_773ebd81`

---

## Findings

### P1

- **[P5-P1-1] `HEADER_SECRET` leaks header suffix material.** `redact.ts:55` — the value class `[^\n\r"',;]*` stops at `"`, `,`, `;` — all valid *inside* a real secret-bearing header. Codex probes:
  - `Authorization: Digest username="alice", …, response="secret"` → `Authorization: ***"alice", …, response="secret"` — the Digest `response` credential leaks.
  - `Cookie: sid=abc; session=secret; theme=dark` → `Cookie: ***; session=secret; theme=dark` — `session=secret` leaks.
  **Patch:** `Authorization` → redact to newline / serialized-field boundary (not comma/semicolon/quote inside the Digest value). `Cookie` → redact the full value (or scan every `;`-separated pair).

- **[P5-P1-2] `KV_SECRET` leaks multi-word quoted values.** `redact.ts:60-61` + `redact.test.ts:43` — the value class stops at the first space, so a quoted multi-word secret leaks its tail. Codex probes:
  - `{"password":"correct horse battery staple"}` → `{"password":"*** horse battery staple"}`.
  - `verification="123 456"` → `verification="*** 456"`.
  The `password=p@ss w0rd → password=*** w0rd` test case encodes that leak as intended.
  **Patch:** distinguish quoted vs unquoted. Quoted (`key="…"` / `key: "…"` / JSON-in-string) → redact to the closing quote (value may contain spaces). Unquoted (URL/form) → keep stop-at-separator. Add quoted multi-word tests.

## Codex answers to audit questions

- Authorization casing/scheme: casing fine; Basic/Bearer whole-value redaction fine; **Digest unsafe** with the current boundary (#1).
- JWT shape: acceptable v1 backstop. May miss `alg=none` empty-signature JWTs — not a blocker vs the header/quoted leaks.
- URL-embedded token: `?token=a&otp=b&user=c` correct; stop-at-`&` is right for query/form.
- Prefix match: `access_token=` redacting, `tokenizer=` not, object-key `tokenizer` over-redaction — all acceptable.
- `redactInputText`: framing acceptable **only if Phase 6 wires `input_text` through `redactInputText` / explicit `sensitive` before `appendEvent`/`appendCommand`**. `redactValue({type:"input_text", text:"my password is hunter2"})` leaves the text unchanged today — so this is a **Phase 6 implementation gate**, not an implicit Phase 5 guarantee.

## Codex verification

- `bun run typecheck` / `lint` (73 files) / `test` (26 files / 258) all pass.
- Direct Bun probes confirmed the false negatives.

## Patch plan (本方接受)

1. **[P5-P1-1]** `HEADER_SECRET` → value class `[^\n\r]*` for both `authorization` and `cookie` (redact the whole header value to newline). The "embedded header inside a JSON string over-redacts trailing fields" case is accepted over-redaction (the stated bias); structured `{Authorization: …}` objects are still handled precisely by the layer-1 key match.
2. **[P5-P1-2]** split `KV_SECRET` into `KV_SECRET_QUOTED` (`key[:=]"value"` → redact to the matching close quote, spaces allowed) and `KV_SECRET_UNQUOTED` (URL/form → stop at separator); run quoted first. Tests for quoted multi-word `password` / `verification`.
3. Carry [P5-P1-2 answer] forward as an explicit **Phase 6 gate**: `input_text` must route through `redactInputText` / `sensitive` before recording.

---

# Phase 5 — Patch round 1

**Date:** 2026-05-20

## Applied

- **[P5-P1-1]** `HEADER_SECRET` value class → `[^\n\r]*` — `Authorization` / `Cookie` headers now redact the entire value to the newline, so a Digest credential (`response="secret"`) or a multi-cookie header (`session=secret`) no longer leaks its tail. Mid-string over-redaction of the rest of a line is accepted (the false-positive-is-noise bias); structured `{Authorization: …}` objects are still handled precisely by the layer-1 key match.
- **[P5-P1-2]** `KV_SECRET` split into `KV_SECRET_QUOTED` (`key[:=]"…"` / JSON-in-string — value runs to the matching close quote, spaces allowed) and `KV_SECRET_UNQUOTED` (URL/form — single token, stop at separator). Quoted pass runs first. A quoted multi-word `password` / `verification` is now consumed whole.

## Tests (263 total, was 258 — redact suite 59, was 54)

- `redactString` table: added quoted multi-word password (JSON form, neighbour field preserved), colon-sep quoted password, quoted multi-word verification, quoted token swallowing a Bearer prefix, `Authorization: Digest` whole-value, multi-cookie whole-value. Relabelled the unquoted single-token case.

## Verify

- `bun run typecheck` ✅ / `bun run lint` ✅ 73 files / `bun run test` ✅ **263/263**.

## Phase 6 gate (carried forward)

`input_text` must route the typed text through `redactInputText` (and honour an explicit `sensitive` flag) BEFORE it reaches `appendEvent` / `appendCommand`. `redactValue` alone does not redact a `text` field — this is a Phase 6 implementation requirement, not a Phase 5 guarantee.

---

# Phase 5 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-20
**Thread:** `review/phase-5`
**Outcome:** **sign-off** — Phase 5 cleared to commit and proceed to Phase 6.
**Source message id:** `2026-05-20T04-19-04.888Z_pid39036_d90179b9`

- P5-P1-1 (header suffix leak) + P5-P1-2 (quoted multi-word leak): fixed and accepted.
- Codex verification: typecheck / lint (73) / test (263) pass; direct probes confirmed Digest / multi-cookie / quoted-multi-word / unquoted-query all redact correctly.
- JWT shape + free-text `tokenizer` behavior: accepted from round 1.
- **Phase 6 gate stands:** `input_text` must route through `redactInputText` / `sensitive` before recording.
