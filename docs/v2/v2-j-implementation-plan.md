# v2-J Implementation Plan - Performance Snapshot

Status: locked 2026-05-29. Executor: Codex. This is the implementation spec for axis C: jank and memory probes.

## 0. Goal

v2-H/v2-I make interaction, navigation, HTTP, logcat, and events explainable on a timeline. They do not answer "was this screen/scroll janky or memory-heavy?"

v2-J adds an on-demand, host-side performance snapshot:

- `dumpsys gfxinfo <pkg>` for frame/jank counters and frame percentile digest.
- `dumpsys meminfo <pkg>` for PSS/heap buckets.
- No app code and no profile EvidenceSource.
- A new MCP tool: `android_debug_perf_snapshot`.

## 1. Locked Decisions

- New tool, not `get_app_state`: performance probes are larger, slower, and optionally resetting. Keeping them separate prevents state snapshots from becoming noisy.
- Input:
  - `runId`
  - `kinds?: ("gfxinfo" | "meminfo")[]`, default both
  - `raw?: boolean`, default false
  - `reset?: boolean`, default false
- `reset:true` means read-and-reset gfxinfo by calling `dumpsys gfxinfo <pkg> reset` after the snapshot. It does not reset meminfo.
- Default output is parsed digest only. Raw dumpsys text appears only with `raw:true`.
- Tool is not read-only because `reset:true` mutates gfxinfo counters and the tool appends command/event rows.
- No startup timing in v2-J. `am start -W` changes app lifecycle and belongs in a later explicit flow.

## 2. Output Shape

Return:

```ts
{
  runId: string,
  packageName: string,
  collectedAt: string,
  reset: boolean,
  gfxinfo?: {
    totalFrames: number | null,
    jankyFrames: number | null,
    jankyPercent: number | null,
    percentilesMs: { p50?: number, p90?: number, p95?: number, p99?: number },
    raw?: string,
  },
  meminfo?: {
    totalPssKb: number | null,
    nativeHeapKb: number | null,
    dalvikHeapKb: number | null,
    graphicsKb: number | null,
    stackKb: number | null,
    codeKb: number | null,
    raw?: string,
  },
  warnings?: string[],
  sessionStatus: SessionStatus
}
```

Parser failures are soft and explicit: missing fields become `null` and warnings describe which sections were not recognized. ADB failures stay hard domain errors via the existing ADB error envelope.

## 3. Implementation Phases

### J1 - Parsers and ADB wrappers

- Add `server/src/adb/perf.ts`.
- Export `collectGfxInfo`, `collectMemInfo`, `resetGfxInfo`.
- Export pure parsers for unit tests.
- Keep parsers tolerant across Android/OEM formatting; do not invent values when a metric is absent.

Verify:

- Unit tests for common `gfxinfo` counters, percentile lines, and `meminfo` totals.
- Malformed/empty sections return nullable digest plus warnings.

### J2 - MCP tool

- Add `server/src/mcp/tools/perf_snapshot.ts`.
- Register it in `bootstrap.ts` and `ANDROID_DEBUG_TOOL_NAMES`.
- Record `commands.jsonl` and `events.jsonl` entries for auditability.
- Update contract tests: inventory size, unknown `runId`, adb-touching documentation.

Verify:

- MCP harness test with mocked ADB output for default digest, `raw:true`, `kinds`, and `reset:true`.

### J3 - Gates

Run:

```bash
bun run typecheck
bun run lint
bun run test -- server/tests/adb/perf.test.ts server/tests/mcp/perf_snapshot.test.ts server/tests/integration/tool_contract.test.ts server/tests/mcp/register.test.ts
bun run test
```

## 4. Out of Scope

- App-side frame instrumentation.
- Perfetto / systrace capture.
- Startup timing via `am start -W`.
- Timeline integration with `extract_evidence_context`.
