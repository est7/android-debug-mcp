import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dispatchQuery } from "../../evidence/queryDispatch.ts";
import { type PullSummary, type RunStats, searchEvidence } from "../../evidence/runtime.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

/** v2-G.1 Block B (lock § Q7): `fullRecords:true && limit > MAX_FULL_LIMIT`
 * is rejected as `query_malformed`. 10 caps a `fullRecords:true` page at
 * ~6.2 MB worst case (poppo_http lang.json ~622 KB × 10) so a single round
 * trip stays under the MCP transport envelope. Agents wanting 100 full
 * records paginate. */
const MAX_FULL_LIMIT = 10;

/**
 * v2-G `search_evidence` (Q4 + Q5+ + Q9 + Q11).
 *
 * Lazy-pull, paginated search over per-source evidence files for the named
 * `runId`'s active session. Q4's discriminated-union by source is enforced
 * INSIDE the handler (see `EvidenceSource.querySchema` doc) — the MCP input
 * schema keeps `query` loose at `{ source: string, ... }.passthrough()` so a
 * static `registerTool` schema survives a profile with zero sources.
 */

const inputSchema = z
  .object({
    runId: runIdInput,
    query: z
      .object({
        source: z
          .string()
          .min(1, "query.source must be non-empty")
          .max(64, "query.source must be <= 64 chars"),
      })
      .passthrough(),
    limit: z
      .number()
      .int("limit must be an integer")
      .min(1, "limit must be >= 1")
      .max(500, "limit must be <= 500")
      .default(100),
    cursor: z.string().min(1, "cursor must be non-empty").optional(),
    fullRecords: z.boolean().default(false).optional(),
  })
  .strict();

const statsRunSchema = z
  .object({
    filesScanned: z.number().int(),
    recordsScanned: z.number().int(),
    pullsTriggered: z.number().int(),
    pulledFiles: z.array(z.string()),
  })
  .strict();

const outputSchema = z
  .object({
    records: z.array(z.record(z.string(), z.unknown())),
    warnings: z.array(z.string()).optional(),
    nextCursor: z.string().optional(),
    statsRun: statsRunSchema,
  })
  .strict();

const description = [
  "Search a debug run's evidence (per-source JSONL files pulled from the device on demand), streaming and paginated.",
  "",
  "Use when: the agent wants records from an evidence source declared by the active session's profile (e.g. HTTP logs from `poppo_http`).",
  "Args: `runId`; `query` (must carry `source: <sourceId>` PLUS at least one source-specific positive filter — e.g. for `poppo_http`: pathPrefix / methodIn / outcome / tsMsRange / hostContains / durationMsGte / errorTypeIn. `excludeHeartbeat` alone does NOT narrow; if you want records around a marker, use `extract_evidence_context` instead — it auto-injects `tsMsRange`); `limit` (1-500, default 100); `cursor` (opaque, from a prior `nextCursor` — pass the same `query` across pages); `fullRecords` (default `false` — records come back through the source's preview projection, with truncation metadata under `record._meta.preview`; pass `true` to disable preview and receive raw records, in which case `limit` is capped at 10).",
  "Source-specific shapes: for `poppo_http`, `tsMsRange` MUST be `{from:number,to:number}` — both bounds required, `to >= from`, window `to - from <= 24h` (86400000 ms). Partial ranges (e.g. `{from:0}`) are rejected as `query_malformed`. A `poppo_http` query without `tsMsRange` is allowed but not session-scoped; the response includes a warning. Use `extract_evidence_context` for narrow marker-anchored windows.",
  "Returns: `{records[], warnings?, nextCursor?, statsRun}`. `warnings` lists soft-empty reasons and non-fatal query caveats such as `poppo_http` calls without `tsMsRange`. `statsRun` reports `{filesScanned, recordsScanned, pullsTriggered, pulledFiles}` for audit / agent metrics. When the source declares preview and `fullRecords` is not set, each record carries `record._meta.preview = {truncated:boolean, fullSizeBytes:number, truncatedFields:string[], redactedFields?:string[]}`. `truncated/truncatedFields` mean size-lossy preview and can justify `fullRecords:true`; `redactedFields` means safety masking and is not counted as truncation.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session went degraded; `query_malformed` when the source-specific fields fail per-source strict validation OR when `fullRecords:true` is combined with `limit > 10` (paginate instead); `query_underspecified` when the source requires at least one narrowing filter and none is supplied; `invalid_cursor` for a tampered or stale cursor.",
].join("\n");

function zeroStats(): RunStats {
  return {
    filesScanned: 0,
    recordsScanned: 0,
    pullsTriggered: 0,
    pulledFiles: [],
  };
}

function queryWarnings(sourceId: string, parsedQuery: Record<string, unknown>): string[] {
  if (sourceId === "poppo_http" && parsedQuery.tsMsRange === undefined) {
    return [
      "poppo_http search is not session-scoped because query.tsMsRange is absent; results may include retained records from earlier app runs. Prefer extract_evidence_context around a marker, or pass an explicit tsMsRange.",
    ];
  }
  return [];
}

/** Clone the runtime's readonly stats into the mutable shape the output schema accepts. */
function toMutableStats(stats: RunStats) {
  return {
    filesScanned: stats.filesScanned,
    recordsScanned: stats.recordsScanned,
    pullsTriggered: stats.pullsTriggered,
    pulledFiles: [...stats.pulledFiles],
  };
}

export function registerSearchEvidence(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_search_evidence",
    {
      title: "Search run evidence",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        // NOT read-only: cache miss writes pulled files + `evidence_pulled`
        // event + a commands.jsonl audit row. Even a cache-hit call writes
        // the commands.jsonl audit row, so the tool is never side-effect-free
        // from the run-folder's perspective.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      const fullRecords = input.fullRecords === true;
      // v2-G.1 Block B (lock § Q7): hard reject `fullRecords:true && limit
      // > 10`. Reject before dispatchQuery so a malformed source-specific
      // query still surfaces `query_malformed` on its own merit if both
      // gates would fire; we want the most actionable error first, and an
      // overshoot on limit is unambiguous.
      if (fullRecords && input.limit > MAX_FULL_LIMIT) {
        throw new ToolDomainError(
          "query_malformed",
          `fullRecords:true requires limit <= ${MAX_FULL_LIMIT}; for more, paginate with cursor`,
          { tool: "search_evidence", limit: input.limit, fullRecords: true },
        );
      }

      const dispatched = dispatchQuery(session.profile, input.query);
      if (dispatched.kind === "malformed") {
        throw dispatched.error;
      }
      if (dispatched.kind === "soft_empty") {
        const stats = zeroStats();
        await session.appendCommand({
          tool: "search_evidence",
          statsRun: stats,
          pullsTriggered: 0,
          pulledFiles: [],
          softEmpty: true,
          warning: dispatched.warning,
          fullRecords,
          truncatedRecords: 0,
          truncatedFullBytesSum: 0,
          savedBytesSum: 0,
        });
        return ok({
          records: [],
          warnings: [dispatched.warning],
          statsRun: toMutableStats(stats),
        });
      }

      const result = await searchEvidence({
        source: dispatched.source,
        parsedQuery: dispatched.parsedQuery,
        ctx: session.evidenceContext(),
        runId: input.runId,
        runDir: session.runDir,
        limit: input.limit,
        cursor: input.cursor ?? null,
        mode: "lazy",
        fullRecords,
      });

      const responseRecords = result.records.map((r) => r as Record<string, unknown>);
      const warnings = queryWarnings(
        dispatched.source.id,
        dispatched.parsedQuery as Record<string, unknown>,
      );
      const previewAudit = computePreviewAudit(responseRecords, fullRecords);
      await emitPullEventsAndCommand(
        session,
        "search_evidence",
        dispatched.source.id,
        result,
        previewAudit,
      );

      return ok({
        records: responseRecords,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        statsRun: toMutableStats(result.statsRun),
      });
    },
  );
}

export { toMutableStats };

/**
 * v2-G.1 Phase 4 — preview audit aggregates for the commands.jsonl row.
 *
 * Computed per page from `result.records`. When the source declared a
 * preview hook AND the caller did not opt into `fullRecords:true`, every
 * record carries `_meta.preview = {truncated, fullSizeBytes,
 * truncatedFields, redactedFields?}`; we count only records that were
 * size-truncated and sum the byte ledger.
 *
 *   - `truncatedRecords` — how many records on this page were lossy.
 *   - `truncatedFullBytesSum` — `Σ fullSizeBytes` over the truncated set.
 *     "How many bytes the agent would have eaten under `fullRecords:true`."
 *   - `savedBytesSum` — `Σ (fullSizeBytes - byteLen(JSON.stringify(previewed)))`
 *     over the truncated set. "How many bytes preview actually saved."
 *
 * Compression ratio (per lock § Q10) = `savedBytesSum / truncatedFullBytesSum`.
 *
 * For records that are NOT truncated (hook returned `truncated:false`), the
 * preview hook still ran but no bytes were saved — those are excluded from
 * the sums but visible as `total records - truncatedRecords`.
 */
interface PreviewAudit {
  readonly fullRecords: boolean;
  readonly truncatedRecords: number;
  readonly truncatedFullBytesSum: number;
  readonly savedBytesSum: number;
}

export function computePreviewAudit(
  records: readonly Record<string, unknown>[],
  fullRecords: boolean,
): PreviewAudit {
  // When `fullRecords:true`, runtime skipped the preview projection, so no
  // record carries `_meta.preview` — all sums stay 0 by construction.
  // Similarly when the source has no `previewForAgent?` (no-hook fallback)
  // the helper exits early and `_meta` is absent.
  let truncatedRecords = 0;
  let truncatedFullBytesSum = 0;
  let savedBytesSum = 0;
  for (const rec of records) {
    const meta = (rec as { _meta?: { preview?: { truncated: boolean; fullSizeBytes: number } } })
      ._meta?.preview;
    if (meta?.truncated !== true) continue;
    truncatedRecords++;
    truncatedFullBytesSum += meta.fullSizeBytes;
    const previewedBytes = Buffer.byteLength(JSON.stringify(rec), "utf8");
    savedBytesSum += meta.fullSizeBytes - previewedBytes;
  }
  return { fullRecords, truncatedRecords, truncatedFullBytesSum, savedBytesSum };
}

/**
 * Q9 audit emission shared by `search_evidence` and `extract_evidence_context`:
 *
 *   - `evidence_pulled` event is appended ONLY when a real pull happened. Cache
 *     hits leave events.jsonl untouched (Q9: "*真实拉* 发生时写").
 *   - `commands.jsonl` always gets one aggregate row keyed by `tool`, mirroring
 *     the capture-mirror format (Q9: "走 aggregate ... capture-mirror 体例").
 *     Phase 4 adds the 4 preview-audit fields (`fullRecords` plus the byte
 *     ledger) so post-run review can reconstruct compression savings.
 *
 * Exported so the sibling extract_evidence_context handler shares the same
 * audit shape — keeping the two tools structurally identical for the
 * post-Phase-3 codex audit.
 */
export async function emitPullEventsAndCommand(
  session: ReturnType<SessionManager["require"]>,
  tool: "search_evidence" | "extract_evidence_context",
  sourceId: string,
  result: { readonly pulls: readonly PullSummary[]; readonly statsRun: RunStats },
  previewAudit: PreviewAudit,
): Promise<void> {
  if (result.pulls.length > 0) {
    await session.appendEvent({
      type: "evidence_pulled",
      source: sourceId,
      // Phase 3 only emits `lazy`; `seal` is emitted by stop_session's force
      // pull (see (g) in the Phase 3 plan). Reading the trigger from the
      // first pull keeps the field truthful when stop_session later reuses
      // this emitter with `mode: "seal"`.
      trigger: result.pulls[0]?.trigger ?? "lazy",
      files: result.pulls.map((p) => basename(p.localPath)),
    });
  }
  await session.appendCommand({
    tool,
    statsRun: result.statsRun,
    pullsTriggered: result.statsRun.pullsTriggered,
    pulledFiles: result.statsRun.pulledFiles.map((p) => basename(p)),
    fullRecords: previewAudit.fullRecords,
    truncatedRecords: previewAudit.truncatedRecords,
    truncatedFullBytesSum: previewAudit.truncatedFullBytesSum,
    savedBytesSum: previewAudit.savedBytesSum,
  });
}
