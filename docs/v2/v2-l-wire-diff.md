# v2-L — Request-parameter snapshot and diff

Status: implemented 0.8.0. Tools: `android_debug_wire_snapshot`, `android_debug_wire_diff`.

## Why

Account refactors must prove a candidate build sends the same requests as a reference build. The Vone repo does this
with an app-side debug recorder (`AccountWireRecorder`) plus `tools/account-wire-diff/baseline_diff.py`. Both apps'
debug builds already write structured `http_*.jsonl` (schema: `submodulepoppo/docs/reference/http-log-jsonl-schema.md`),
so the server can produce the recorder's projection from it and run the comparison, with no recorder in the app.

## Design

- `server/src/wire/project.ts` — `http_*.jsonl` record → recorder-shaped record (`method`, `path`, `query` pairs,
  `headers` names, `encrypted`, `fields`, `role`, `time`, `seq`). Rules follow `AccountWireRecorder.project`:
  encrypted (`_sign` in the envelope) → `fields` = `request.decoded` minus `_mtime` / `b_vpn`; otherwise the envelope
  (GET query, POST form from `request.body.text`) minus the app's injected globals; a POST's query-only extras are
  added; fields sorted by key.
- Redaction happens at snapshot time, by key name: credentials, codes, tokens, signatures and device ids become
  `<redacted>` (empty stays empty — the comparison looks at empty-versus-present); `uid` / `userid` / `_uid` / `phone`
  / `email` values become per-snapshot aliases `<uid:n>`, `<phone:n>`, `<email:n>`. Nested decoded objects are
  scrubbed recursively. The password copied into the `user/login` URL query is redacted like any `password` key.
- `server/src/wire/compare.ts` — port of `baseline_diff.py` (normalization, grouping by method + path +
  `type`/`login_type`/`use`, statuses MATCH / CHANGED / MISSING / EXTRA / DUPLICATE, report order). Cross-checked
  against a vendored copy of the Python tool on shared fixtures (`server/tests/wire/crosscheck.test.ts`), and against
  the original on the S16 pair when the Vone checkout is present.
- One deliberate difference: a record with `role: null` is accepted (Python raises `KeyError`). Role is then left out
  of the comparison on both sides and the result says `roleCompared:false`. A producer-side `request.owner.role`
  (`Current` / `Candidate` / `Anonymous` / `Untagged`) turns role comparison on.

## Sources of a snapshot

`runId` of an active session pulls the device's `http-logs` first (same cache as `search_evidence`); a finished run
uses what it already pulled; `files` + `outDir` reads local files without a run. Window: epoch ms or mark names
(last occurrence of a mark wins, as in `search_logs`).
