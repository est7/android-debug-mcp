# Wire fixtures

All data here is synthetic. Nothing is copied from a device recording.

- `baseline_diff.py` — verbatim copy of `submodulevone/tools/account-wire-diff/baseline_diff.py` (commit `12b79691`,
  sha256 `e026a6b4c2286aa45b6e6f6c8aebeab8e774aa7d0d9d6e9356cdeb80b5445d36`). `crosscheck.test.ts` runs it and the
  TypeScript port on the same inputs and requires identical reports.
- `baseline.legacy.jsonl` — baseline in the phase-0 `projection.wire` shape.
- `capture.recorder.jsonl` — capture in the Vone recorder shape.
- `http_synthetic.jsonl` — `http_*.jsonl` (schema rev4) records for the snapshot tool: an encrypted GET with
  `request.decoded`, an unencrypted GET, a POST form login with the password also copied into the URL query, repeated
  uid / phone / email values, a transport error, a record with `request.owner.role`, and a half-written last line.
