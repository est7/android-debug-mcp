import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dispatchQuery } from "../../evidence/queryDispatch.ts";
import { type PullSummary, type RunStats, searchEvidence } from "../../evidence/runtime.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

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
  "Args: `runId`; `query` (must carry `source: <sourceId>` PLUS at least one source-specific positive filter — e.g. for `poppo_http`: pathPrefix / methodIn / outcome / tsMsRange / hostContains / durationMsGte / errorTypeIn. `excludeHeartbeat` alone does NOT narrow; if you want records around a marker, use `extract_evidence_context` instead — it auto-injects `tsMsRange`); `limit` (1-500, default 100); `cursor` (opaque, from a prior `nextCursor` — pass the same `query` across pages).",
  "Source-specific shapes: for `poppo_http`, `tsMsRange` MUST be `{from:number,to:number}` — both bounds required, `to >= from`, window `to - from <= 24h` (86400000 ms). Partial ranges (e.g. `{from:0}`) are rejected as `query_malformed`. Use `extract_evidence_context` for narrow marker-anchored windows.",
  "Returns: `{records[], warnings?, nextCursor?, statsRun}`. `warnings` lists soft-empty reasons (no profile loaded, source has no provider). `statsRun` reports `{filesScanned, recordsScanned, pullsTriggered, pulledFiles}` for audit / agent metrics.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session went degraded; `query_malformed` when the source-specific fields fail per-source strict validation; `query_underspecified` when the source requires at least one narrowing filter and none is supplied; `invalid_cursor` for a tampered or stale cursor.",
].join("\n");

function zeroStats(): RunStats {
  return {
    filesScanned: 0,
    recordsScanned: 0,
    pullsTriggered: 0,
    pulledFiles: [],
  };
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
      });

      await emitPullEventsAndCommand(session, "search_evidence", dispatched.source.id, result);

      return ok({
        records: result.records.map((r) => r as Record<string, unknown>),
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        statsRun: toMutableStats(result.statsRun),
      });
    },
  );
}

export { toMutableStats };

/**
 * Q9 audit emission shared by `search_evidence` and `extract_evidence_context`:
 *
 *   - `evidence_pulled` event is appended ONLY when a real pull happened. Cache
 *     hits leave events.jsonl untouched (Q9: "*真实拉* 发生时写").
 *   - `commands.jsonl` always gets one aggregate row keyed by `tool`, mirroring
 *     the capture-mirror format (Q9: "走 aggregate ... capture-mirror 体例").
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
  });
}
