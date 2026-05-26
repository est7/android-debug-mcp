import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dispatchQuery } from "../../evidence/queryDispatch.ts";
import { searchEvidence } from "../../evidence/runtime.ts";
import type { EvidenceQuery } from "../../profile/types.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";
import { emitPullEventsAndCommand, toMutableStats } from "./search_evidence.ts";

/**
 * v2-G `extract_evidence_context` (Q7 + Q8 + Q11).
 *
 * Mirrors v1 `extract_crash_context`: an agent supplies a marker timestamp
 * (copied verbatim from `events.jsonl ts`) plus a +/- ms window, and the tool
 * returns evidence records that fall inside the window. Implemented as a
 * `search_evidence` call with `tsMsRange` decorating the source-specific
 * query — Q8 explicitly subtracts `tsMsRange` from the agent-side query so
 * the marker/window IS the time-range filter.
 *
 * The tool exists alongside `search_evidence` instead of being a thin alias
 * because (a) it gives agents a discoverable name for the "evidence around
 * crash X" pattern and (b) it leaves room for future server-side correlation
 * (e.g. auto-attach the matching `mark_event` or crash record).
 */

const MIN_WINDOW_MS = 0;
const MAX_WINDOW_MS = 60_000;
const DEFAULT_WINDOW_MS = 5_000;

const inputSchema = z
  .object({
    runId: runIdInput,
    /**
     * ISO 8601 instant — agent copies this directly from `events.jsonl ts`
     * (which is `new Date().toISOString()`). `.datetime({ offset: true })`
     * accepts both UTC `Z` and explicit-offset forms.
     */
    markerIsoTs: z.string().datetime({ offset: true, message: "markerIsoTs must be ISO 8601" }),
    beforeMs: z
      .number()
      .int("beforeMs must be an integer")
      .min(MIN_WINDOW_MS, "beforeMs must be >= 0")
      .max(MAX_WINDOW_MS, `beforeMs must be <= ${MAX_WINDOW_MS}`)
      .default(DEFAULT_WINDOW_MS),
    afterMs: z
      .number()
      .int("afterMs must be an integer")
      .min(MIN_WINDOW_MS, "afterMs must be >= 0")
      .max(MAX_WINDOW_MS, `afterMs must be <= ${MAX_WINDOW_MS}`)
      .default(DEFAULT_WINDOW_MS),
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
    /** Echo of the resolved tsMsRange — useful for the agent to confirm window math. */
    tsMsRange: z.object({ from: z.number().int(), to: z.number().int() }).strict(),
  })
  .strict();

const description = [
  "Extract evidence records around a marker timestamp recorded in a debug run's `events.jsonl`.",
  "",
  "Use when: the agent has an interesting event (mark, crash, evidence_pulled) and wants the source's records inside the window around it.",
  "Args: `runId`; `markerIsoTs` (the `ts` field copied verbatim from a prior event); `beforeMs` / `afterMs` (0-60000, default 5000); `query` (must carry `source: <sourceId>` — same shape as `search_evidence.query`, minus any `tsMsRange` field — this tool injects `tsMsRange` from the marker); `limit` (1-500, default 100); `cursor` (opaque pagination).",
  "Returns: `{records[], warnings?, nextCursor?, statsRun, tsMsRange}`. `tsMsRange` echoes the resolved `{from, to}` window so the agent can verify the math.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session went degraded; `invalid_argument` when `query.tsMsRange` is set (this tool owns that field); `query_malformed` when the source-specific fields fail per-source strict validation; `invalid_cursor` for a tampered cursor.",
].join("\n");

export function registerExtractEvidenceContext(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_extract_evidence_context",
    {
      title: "Extract evidence context",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        // Same logic as search_evidence: lazy pull may write files + events,
        // and a commands.jsonl row is always written. Not read-only.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      // Q8: this tool owns tsMsRange — reject if the agent tried to set it too.
      // Loose check: the input.query is `.passthrough()` so we read it ad-hoc.
      const queryWithMaybeTsRange = input.query as { tsMsRange?: unknown };
      if (queryWithMaybeTsRange.tsMsRange !== undefined) {
        throw new ToolDomainError(
          "invalid_argument",
          "query.tsMsRange must not be set on extract_evidence_context — this tool injects tsMsRange from markerIsoTs/beforeMs/afterMs",
          { tool: "extract_evidence_context" },
        );
      }

      const markerMs = new Date(input.markerIsoTs).getTime();
      const tsMsRange = {
        from: markerMs - input.beforeMs,
        to: markerMs + input.afterMs,
      };
      // Build the decorated query *after* the dispatch check so a profile
      // soft-empty path doesn't bother computing it (and so the per-source
      // strict validation sees the real shape including tsMsRange).
      const decorated = { ...input.query, tsMsRange };

      const dispatched = dispatchQuery(session.profile, decorated);
      if (dispatched.kind === "malformed") {
        throw dispatched.error;
      }
      if (dispatched.kind === "soft_empty") {
        const ZERO_STATS = {
          filesScanned: 0,
          recordsScanned: 0,
          pullsTriggered: 0,
          pulledFiles: [] as string[],
        };
        await session.appendCommand({
          tool: "extract_evidence_context",
          statsRun: ZERO_STATS,
          pullsTriggered: 0,
          pulledFiles: [],
          softEmpty: true,
          warning: dispatched.warning,
          tsMsRange,
        });
        return ok({
          records: [],
          warnings: [dispatched.warning],
          statsRun: ZERO_STATS,
          tsMsRange,
        });
      }

      const result = await searchEvidence({
        source: dispatched.source,
        parsedQuery: dispatched.parsedQuery as EvidenceQuery,
        ctx: session.evidenceContext(),
        runId: input.runId,
        runDir: session.runDir,
        limit: input.limit,
        cursor: input.cursor ?? null,
        mode: "lazy",
      });

      await emitPullEventsAndCommand(
        session,
        "extract_evidence_context",
        dispatched.source.id,
        result,
      );

      return ok({
        records: result.records.map((r) => r as Record<string, unknown>),
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        statsRun: toMutableStats(result.statsRun),
        tsMsRange,
      });
    },
  );
}
