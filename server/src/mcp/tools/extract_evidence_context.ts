import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dispatchQuery } from "../../evidence/queryDispatch.ts";
import { type PullSummary, type RunStats, searchEvidence } from "../../evidence/runtime.ts";
import type { EvidenceQuery } from "../../profile/types.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";
import {
  computePreviewAudit,
  emitPullEventsAndCommand,
  toMutableStats,
} from "./search_evidence.ts";

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

const sourceQueryInput = z
  .object({
    source: z.string().min(1, "source must be non-empty").max(64, "source must be <= 64 chars"),
  })
  .passthrough();

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
      .max(
        MAX_WINDOW_MS,
        `beforeMs must be <= ${MAX_WINDOW_MS}. Retry with beforeMs <= ${MAX_WINDOW_MS}; use search_evidence with explicit tsMsRange for wider windows.`,
      )
      .default(DEFAULT_WINDOW_MS),
    afterMs: z
      .number()
      .int("afterMs must be an integer")
      .min(MIN_WINDOW_MS, "afterMs must be >= 0")
      .max(
        MAX_WINDOW_MS,
        `afterMs must be <= ${MAX_WINDOW_MS}. Retry with afterMs <= ${MAX_WINDOW_MS}; use search_evidence with explicit tsMsRange for wider windows.`,
      )
      .default(DEFAULT_WINDOW_MS),
    query: sourceQueryInput.optional(),
    sources: z
      .array(sourceQueryInput)
      .min(1, "sources must contain at least one source")
      .optional(),
    limit: z
      .number()
      .int("limit must be an integer")
      .min(1, "limit must be >= 1")
      .max(500, "limit must be <= 500")
      .default(100),
    cursor: z.string().min(1, "cursor must be non-empty").optional(),
    fields: z.array(z.string().min(1).max(64)).max(16).optional(),
    fullRecords: z.boolean().default(false).optional(),
  })
  .strict();

/** Phase 3: same MAX_FULL_LIMIT as `search_evidence` — kept in sync via this
 * file-local constant so the two tools surface a consistent error. */
const MAX_FULL_LIMIT = 10;

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
  "Args: `runId`; `markerIsoTs` (the `ts` field copied verbatim from a prior event); `beforeMs` / `afterMs` (0-60000, default 5000); exactly one of `query` or `sources`. `query` is the single-source, paginated path (must carry `source: <sourceId>` — same shape as `search_evidence.query`, minus any `tsMsRange` field; this tool injects a bounded `tsMsRange:{from,to}` from the marker). `sources` is the multi-source timeline path: an array of source-specific queries, each without `tsMsRange`; records are merged by `tsMs` into a digest sequence. `limit` (1-500, default 100); `cursor` (single-source `query` path only); `fields` (default digest; for `poppo_http` opt into sections: request.headers|request.params|request.body|request.decoded|response.headers|response.body); `fullRecords` (default `false`; pass `true` for all sections with body untruncated, still source-redacted, limit capped at 10).",
  "Multi-source timeline: `sources` includes evidence sources only (for example `poppo_http` plus `poppo_nav`); logcat/events are not included. Multi-source mode is not paginated: when merged records exceed `limit`, the tool truncates the response and returns warning `multi-source truncated at limit; narrow ts/sources`.",
  "Returns: `{records[], warnings?, nextCursor?, statsRun, tsMsRange}`. `tsMsRange` echoes the resolved `{from, to}` window so the agent can verify the math. When the source declares preview, each record carries `record._meta.preview = {truncated, fullSizeBytes, truncatedFields, redactedFields?, available?, sizes?}`. `available/sizes` describe source sections available on that record after redaction. `truncated/truncatedFields` mean size-lossy preview; `redactedFields` means safety masking and is not counted as truncation.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session went degraded; `invalid_argument` when `query.tsMsRange` is set (this tool owns that field); `query_malformed` when the source-specific fields fail per-source strict validation OR when `fullRecords:true` is combined with `limit > 10` (paginate instead); `invalid_cursor` for a tampered cursor.",
].join("\n");

function zeroStats(): RunStats {
  return {
    filesScanned: 0,
    recordsScanned: 0,
    pullsTriggered: 0,
    pulledFiles: [],
  };
}

function addStats(a: RunStats, b: RunStats): RunStats {
  return {
    filesScanned: a.filesScanned + b.filesScanned,
    recordsScanned: a.recordsScanned + b.recordsScanned,
    pullsTriggered: a.pullsTriggered + b.pullsTriggered,
    pulledFiles: [...a.pulledFiles, ...b.pulledFiles],
  };
}

function pushWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function recordTsMs(record: Record<string, unknown>): number {
  const tsMs = record.tsMs;
  if (typeof tsMs !== "number" || !Number.isFinite(tsMs)) {
    throw new Error("multi-source extract_evidence_context record is missing numeric tsMs");
  }
  return tsMs;
}

async function emitEvidencePulledEvent(
  session: ReturnType<SessionManager["require"]>,
  sourceId: string,
  pulls: readonly PullSummary[],
): Promise<void> {
  if (pulls.length === 0) return;
  await session.appendEvent({
    type: "evidence_pulled",
    source: sourceId,
    trigger: pulls[0]?.trigger ?? "lazy",
    files: pulls.map((p) => basename(p.localPath)),
  });
}

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

      const fullRecords = input.fullRecords === true;
      // v2-G.1 Block B (lock § Q7): same reject as search_evidence — mirror
      // the gate so the two tools surface a consistent error envelope. Runs
      // before the tsMsRange check below so a doubly-malformed call surfaces
      // the more actionable error (the limit / fullRecords combination is
      // unambiguous).
      if (fullRecords && input.limit > MAX_FULL_LIMIT) {
        throw new ToolDomainError(
          "query_malformed",
          `fullRecords:true requires limit <= ${MAX_FULL_LIMIT}; for more, paginate with cursor`,
          { tool: "extract_evidence_context", limit: input.limit, fullRecords: true },
        );
      }

      const hasQuery = input.query !== undefined;
      const hasSources = input.sources !== undefined;
      if (hasQuery && hasSources) {
        throw new ToolDomainError(
          "query_malformed",
          "query and sources are mutually exclusive; provide exactly one",
          { tool: "extract_evidence_context" },
        );
      }
      if (!hasQuery && !hasSources) {
        throw new ToolDomainError("query_malformed", "one of query or sources is required", {
          tool: "extract_evidence_context",
        });
      }

      // Q8: this tool owns tsMsRange — reject if the agent tried to set it too.
      // Loose check: the input.query is `.passthrough()` so we read it ad-hoc.
      const query = input.query;
      if (query !== undefined && (query as { tsMsRange?: unknown }).tsMsRange !== undefined) {
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

      if (input.sources !== undefined) {
        if (input.cursor !== undefined) {
          throw new ToolDomainError(
            "query_malformed",
            "cursor is not supported with sources; multi-source extract_evidence_context is not paginated",
            { tool: "extract_evidence_context" },
          );
        }

        let stats = zeroStats();
        const warnings: string[] = [];
        const records: Record<string, unknown>[] = [];
        let truncated = false;

        for (const sourceQuery of input.sources) {
          if ((sourceQuery as { tsMsRange?: unknown }).tsMsRange !== undefined) {
            throw new ToolDomainError(
              "invalid_argument",
              "sources[].tsMsRange must not be set on extract_evidence_context — this tool injects tsMsRange from markerIsoTs/beforeMs/afterMs",
              { tool: "extract_evidence_context" },
            );
          }

          const decorated = { ...sourceQuery, tsMsRange };
          const dispatched = dispatchQuery(session.profile, decorated);
          if (dispatched.kind === "malformed") {
            throw dispatched.error;
          }
          if (dispatched.kind === "soft_empty") {
            pushWarning(warnings, dispatched.warning);
            continue;
          }

          const result = await searchEvidence({
            source: dispatched.source,
            parsedQuery: dispatched.parsedQuery as EvidenceQuery,
            ctx: session.evidenceContext(),
            runId: input.runId,
            runDir: session.runDir,
            limit: input.limit,
            cursor: null,
            mode: "lazy",
            ...(input.fields !== undefined ? { fields: input.fields } : {}),
            fullRecords,
          });

          await emitEvidencePulledEvent(session, dispatched.source.id, result.pulls);
          stats = addStats(stats, result.statsRun);
          if (result.nextCursor !== null) truncated = true;
          records.push(...result.records.map((r) => r as Record<string, unknown>));
        }

        records.sort((a, b) => {
          const d = recordTsMs(a) - recordTsMs(b);
          if (d !== 0) return d;
          const sa = String(a.source);
          const sb = String(b.source);
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
        if (records.length > input.limit) {
          truncated = true;
        }
        const responseRecords = records.slice(0, input.limit);
        if (truncated) {
          pushWarning(warnings, "multi-source truncated at limit; narrow ts/sources");
        }

        const previewAudit = computePreviewAudit(responseRecords, fullRecords);
        await session.appendCommand({
          tool: "extract_evidence_context",
          statsRun: stats,
          pullsTriggered: stats.pullsTriggered,
          pulledFiles: stats.pulledFiles.map((p) => basename(p)),
          fullRecords: previewAudit.fullRecords,
          truncatedRecords: previewAudit.truncatedRecords,
          truncatedFullBytesSum: previewAudit.truncatedFullBytesSum,
          savedBytesSum: previewAudit.savedBytesSum,
        });

        return ok({
          records: responseRecords,
          ...(warnings.length > 0 ? { warnings } : {}),
          statsRun: toMutableStats(stats),
          tsMsRange,
        });
      }

      if (query === undefined) {
        throw new Error("unreachable: query is required past sources branch");
      }
      // Build the decorated query *after* the dispatch check so a profile
      // soft-empty path doesn't bother computing it (and so the per-source
      // strict validation sees the real shape including tsMsRange).
      const decorated = { ...query, tsMsRange };

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
          fullRecords,
          truncatedRecords: 0,
          truncatedFullBytesSum: 0,
          savedBytesSum: 0,
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
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        fullRecords,
      });

      const responseRecords = result.records.map((r) => r as Record<string, unknown>);
      const previewAudit = computePreviewAudit(responseRecords, fullRecords);
      await emitPullEventsAndCommand(
        session,
        "extract_evidence_context",
        dispatched.source.id,
        result,
        previewAudit,
      );

      return ok({
        records: responseRecords,
        ...(result.nextCursor !== null ? { nextCursor: result.nextCursor } : {}),
        statsRun: toMutableStats(result.statsRun),
        tsMsRange,
      });
    },
  );
}
