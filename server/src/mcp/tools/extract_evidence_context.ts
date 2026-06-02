import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAppPids } from "../../adb/app.ts";
import { dispatchQuery } from "../../evidence/queryDispatch.ts";
import { type PullSummary, type RunStats, searchEvidence } from "../../evidence/runtime.ts";
import { logcatTsToEpochMs } from "../../logcat/ts.ts";
import type { EvidenceQuery } from "../../profile/types.ts";
import { redactString } from "../../redact/redact.ts";
import { readLinesFrom } from "../../search/line_reader.ts";
import {
  LOG_LEVELS,
  type LogEntryFilterOptions,
  hasPositiveLogFilter,
  logEntryMatches,
  parseLogLine,
} from "../../search/search_logs.ts";
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

const logcatTimelineQuerySchema = z
  .object({
    source: z.literal("logcat"),
    query: z.string().min(1, "query must be non-empty").max(2_000, "query too long").optional(),
    level: z.enum(LOG_LEVELS).optional(),
    buffer: z.enum(["main", "system", "crash"]).optional(),
    tags: z
      .array(z.string().min(1, "tag must be non-empty").max(256, "tag too long"))
      .min(1, "tags must list at least one tag")
      .max(100, "tags list too long")
      .optional(),
    pids: z
      .array(z.number().int().nonnegative("pid must be >= 0"))
      .min(1, "pids must list at least one pid")
      .max(100, "pids list too long")
      .optional(),
    excludeTags: z
      .array(z.string().min(1, "tag must be non-empty").max(256, "tag too long"))
      .min(1, "excludeTags must list at least one tag")
      .max(100, "excludeTags list too long")
      .optional(),
  })
  .strict();

const eventsTimelineQuerySchema = z
  .object({
    source: z.literal("events"),
    typeIn: z
      .array(z.string().min(1, "event type must be non-empty").max(128, "event type too long"))
      .min(1, "typeIn must list at least one event type")
      .max(100, "typeIn list too long")
      .optional(),
  })
  .strict();

type LogcatTimelineQuery = z.output<typeof logcatTimelineQuerySchema>;
type EventsTimelineQuery = z.output<typeof eventsTimelineQuerySchema>;

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
    bytesPulled: z.number().int().nonnegative(),
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
  "Args: `runId`; `markerIsoTs` (the `ts` field copied verbatim from a prior event); `beforeMs` / `afterMs` (0-60000, default 5000); exactly one of `query` or `sources`. `query` is the single-source, paginated path (must carry `source: <sourceId>` — same shape as `search_evidence.query`, minus any `tsMsRange` field; this tool injects a bounded `tsMsRange:{from,to}` from the marker). `sources` is the multi-source timeline path: an array of source-specific queries, each without `tsMsRange`; records are merged by `tsMs` into a digest sequence. `sources` accepts profile evidence sources plus pseudo-sources `logcat` and `events`. `logcat` requires at least one positive narrowing filter (`query`, `level`, `tags`, or `pids`); when `pids` is omitted, the logcat contribution defaults to the session app's current pids resolved at query time. Explicit `pids` override that default, and `pids` plus `tags` compose as AND filters. If app pids cannot be resolved, logcat falls back to the caller's unscoped filters and returns a warning. If the run has no device timezone, it contributes no records and returns warning `logcat timeline unavailable: device timezone unknown`. Profile-declared noisy tags are excluded by default unless an explicit positive `tags` filter is supplied. Messages are redacted on output. `events` supports `typeIn`; `crash` events carry `ref:\"crash#<index>\"` for `extract_crash_context`, and `evidence_pulled` is suppressed unless explicitly requested by `typeIn`. `limit` (1-500, default 100); `cursor` (single-source `query` path only); `fields` (default digest; for `poppo_http` opt into sections: request.headers|request.params|request.body|request.decoded|response.headers|response.body); `fullRecords` (default `false`; pass `true` for all sections with body untruncated, still source-redacted, limit capped at 10).",
  'Multi-source timeline is not paginated: when merged records exceed `limit`, the tool truncates the response and returns warning text that points to `search_logs({count:true, groupBy:"tag"})` for log-volume diagnosis.',
  "Returns: `{records[], warnings?, nextCursor?, statsRun, tsMsRange}`. `tsMsRange` echoes the resolved `{from, to}` window so the agent can verify the math. When the source declares preview, each record carries `record._meta.preview = {truncated, fullSizeBytes, truncatedFields, redactedFields?, available?, sizes?}`. `available/sizes` describe source sections available on that record after redaction. `truncated/truncatedFields` mean size-lossy preview; `redactedFields` means safety masking and is not counted as truncation.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session went degraded; `invalid_argument` when `query.tsMsRange` is set (this tool owns that field); `query_malformed` when the source-specific fields fail per-source strict validation OR when `fullRecords:true` is combined with `limit > 10` (paginate instead); `invalid_cursor` for a tampered cursor.",
].join("\n");

function zeroStats(): RunStats {
  return {
    filesScanned: 0,
    recordsScanned: 0,
    pullsTriggered: 0,
    pulledFiles: [],
    bytesPulled: 0,
  };
}

function addStats(a: RunStats, b: RunStats): RunStats {
  return {
    filesScanned: a.filesScanned + b.filesScanned,
    recordsScanned: a.recordsScanned + b.recordsScanned,
    pullsTriggered: a.pullsTriggered + b.pullsTriggered,
    pulledFiles: [...a.pulledFiles, ...b.pulledFiles],
    bytesPulled: a.bytesPulled + b.bytesPulled,
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
    bytesPulled: pulls.reduce((sum, p) => sum + p.sizeBytes, 0),
    fileBytes: pulls.map((p) => ({ file: basename(p.localPath), bytes: p.sizeBytes })),
  });
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function parseLogcatTimelineQuery(query: Record<string, unknown>): LogcatTimelineQuery {
  const result = logcatTimelineQuerySchema.safeParse(query);
  if (!result.success) {
    throw new ToolDomainError(
      "query_malformed",
      `query for source 'logcat' failed validation: ${formatZodError(result.error)}`,
      { source: "logcat" },
    );
  }
  if (!hasPositiveLogFilter(logFilters(result.data))) {
    throw new ToolDomainError(
      "query_malformed",
      "logcat timeline requires at least one narrowing filter: query, level, tags, or pids. buffer / excludeTags alone do not narrow.",
      { source: "logcat" },
    );
  }
  return result.data;
}

function parseEventsTimelineQuery(query: Record<string, unknown>): EventsTimelineQuery {
  const result = eventsTimelineQuerySchema.safeParse(query);
  if (!result.success) {
    throw new ToolDomainError(
      "query_malformed",
      `query for source 'events' failed validation: ${formatZodError(result.error)}`,
      { source: "events" },
    );
  }
  return result.data;
}

function truncateLogMessage(message: string): string {
  const maxChars = 200;
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars)}…[message cut: ${message.length} chars]`;
}

function logFilters(query: LogcatTimelineQuery): LogEntryFilterOptions {
  return {
    ...(query.query !== undefined ? { query: query.query } : {}),
    ...(query.level !== undefined ? { level: query.level } : {}),
    ...(query.buffer !== undefined ? { buffer: query.buffer } : {}),
    ...(query.tags !== undefined ? { tags: query.tags } : {}),
    ...(query.pids !== undefined ? { pids: query.pids } : {}),
    ...(query.excludeTags !== undefined ? { excludeTags: query.excludeTags } : {}),
  };
}

async function collectLogcatTimeline(input: {
  readonly runDir: string;
  readonly query: LogcatTimelineQuery;
  readonly tsMsRange: { readonly from: number; readonly to: number };
  readonly sessionStartMs: number;
  readonly deviceTimezone: string;
  readonly limit: number;
}): Promise<{
  readonly records: Record<string, unknown>[];
  readonly stats: RunStats;
  readonly truncated: boolean;
}> {
  const path = join(input.runDir, "logcat.jsonl");
  const filters = logFilters(input.query);
  const records: Record<string, unknown>[] = [];
  let scanned = 0;
  let current: Record<string, unknown> | null = null;

  for await (const { text } of readLinesFrom(path)) {
    scanned++;
    const entry = parseLogLine(text);
    if (entry === null || !logEntryMatches(entry, filters)) continue;
    const tsMs = logcatTsToEpochMs(entry.tsRaw, input.sessionStartMs, input.deviceTimezone);
    if (tsMs === null || tsMs < input.tsMsRange.from || tsMs > input.tsMsRange.to) continue;
    // Egress redaction: logcat.jsonl is raw on disk (decision #6); redact the
    // full message BEFORE truncating so a secret straddling the cut is caught.
    const sample = truncateLogMessage(redactString(entry.message));
    const sameGroup =
      current !== null &&
      current.level === entry.level &&
      current.tag === entry.tag &&
      current.pid === entry.pid;
    if (!sameGroup) {
      current = {
        source: "logcat",
        tsMs,
        lastTsMs: tsMs,
        level: entry.level,
        tag: entry.tag,
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        count: 1,
        sample,
        rawLineNoFirst: entry.rawLineNo,
        rawLineNoLast: entry.rawLineNo,
      };
      records.push(current);
      continue;
    }
    const group = current;
    if (group === null) throw new Error("logcat timeline grouping invariant violated");
    group.lastTsMs = tsMs;
    group.count = (group.count as number) + 1;
    group.rawLineNoLast = entry.rawLineNo;
  }

  const cap = Math.min(25, Math.max(5, Math.floor(input.limit / 4)));
  const truncated = records.length > cap;
  return {
    records: truncated ? records.slice(0, cap) : records,
    truncated,
    stats: {
      filesScanned: existsSync(path) ? 1 : 0,
      recordsScanned: scanned,
      pullsTriggered: 0,
      pulledFiles: [],
      bytesPulled: 0,
    },
  };
}

function parseEventLine(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function includeEvent(event: Record<string, unknown>, query: EventsTimelineQuery): boolean {
  const type = event.type;
  if (typeof type !== "string") return false;
  if (query.typeIn !== undefined) return query.typeIn.includes(type);
  return type !== "evidence_pulled";
}

function eventDigest(
  event: Record<string, unknown>,
  tsMs: number,
  crashIndex: number | null,
): Record<string, unknown> | null {
  const type = event.type;
  if (typeof type !== "string") return null;
  const out: Record<string, unknown> = { source: "events", tsMs, type };
  if (type === "mark" && typeof event.name === "string") {
    out.name = event.name;
  } else if (type === "lifecycle" && typeof event.phase === "string") {
    out.phase = event.phase;
  } else if (type === "crash") {
    if (typeof event.crashType === "string") out.crashType = event.crashType;
    if (typeof event.topFrame === "string") out.topFrame = event.topFrame;
    if (crashIndex !== null) out.ref = `crash#${crashIndex}`;
  } else if (type === "evidence_pulled" && typeof event.source === "string") {
    out.evidenceSource = event.source;
  }
  return out;
}

async function collectEventsTimeline(input: {
  readonly runDir: string;
  readonly query: EventsTimelineQuery;
  readonly tsMsRange: { readonly from: number; readonly to: number };
}): Promise<{ readonly records: Record<string, unknown>[]; readonly stats: RunStats }> {
  const path = join(input.runDir, "events.jsonl");
  const records: Record<string, unknown>[] = [];
  let scanned = 0;
  let crashCount = 0;

  for await (const { text } of readLinesFrom(path)) {
    scanned++;
    const event = parseEventLine(text);
    if (event === null) continue;
    const type = event.type;
    const crashIndex = type === "crash" ? crashCount++ : null;
    if (!includeEvent(event, input.query)) continue;
    const tsRaw = event.ts;
    if (typeof tsRaw !== "string") continue;
    const tsMs = Date.parse(tsRaw);
    if (!Number.isFinite(tsMs) || tsMs < input.tsMsRange.from || tsMs > input.tsMsRange.to) {
      continue;
    }
    const digest = eventDigest(event, tsMs, crashIndex);
    if (digest !== null) records.push(digest);
  }

  return {
    records,
    stats: {
      filesScanned: existsSync(path) ? 1 : 0,
      recordsScanned: scanned,
      pullsTriggered: 0,
      pulledFiles: [],
      bytesPulled: 0,
    },
  };
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

          if (sourceQuery.source === "logcat") {
            const parsed = parseLogcatTimelineQuery(sourceQuery as Record<string, unknown>);
            const ctx = session.evidenceContext();
            if (ctx.deviceTimezone === null) {
              pushWarning(warnings, "logcat timeline unavailable: device timezone unknown");
              continue;
            }
            // F2: default-exclude the profile's noisy tags, but only when the
            // agent did NOT pin an explicit positive `tags` filter (an explicit
            // `tags` means they want exactly those — possibly a "noisy" one).
            const noisy = session.profile?.logcatTimelineExcludeTags ?? [];
            let effective: LogcatTimelineQuery =
              parsed.tags === undefined && noisy.length > 0
                ? { ...parsed, excludeTags: [...(parsed.excludeTags ?? []), ...noisy] }
                : parsed;
            if (parsed.pids === undefined) {
              const pids = await getAppPids(session.deviceSerial, session.packageName);
              session.setPids(pids);
              if (pids.length > 0) {
                effective = { ...effective, pids };
              } else {
                pushWarning(
                  warnings,
                  `logcat timeline could not resolve current app pids for ${session.packageName}; falling back to unscoped logcat`,
                );
              }
            }
            const result = await collectLogcatTimeline({
              runDir: session.runDir,
              query: effective,
              tsMsRange,
              sessionStartMs: ctx.sessionStartMs,
              deviceTimezone: ctx.deviceTimezone,
              limit: input.limit,
            });
            stats = addStats(stats, result.stats);
            if (result.truncated) {
              pushWarning(
                warnings,
                'logcat timeline truncated before merge; narrow logcat filters or inspect tags with search_logs({count:true, groupBy:"tag"})',
              );
            }
            records.push(...result.records);
            continue;
          }

          if (sourceQuery.source === "events") {
            const parsed = parseEventsTimelineQuery(sourceQuery as Record<string, unknown>);
            const result = await collectEventsTimeline({
              runDir: session.runDir,
              query: parsed,
              tsMsRange,
            });
            stats = addStats(stats, result.stats);
            records.push(...result.records);
            continue;
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
          pushWarning(
            warnings,
            'multi-source truncated at limit; narrow ts/sources or inspect log volume with search_logs({count:true, groupBy:"tag"})',
          );
        }

        const previewAudit = computePreviewAudit(responseRecords, fullRecords);
        await session.appendCommand({
          tool: "extract_evidence_context",
          statsRun: stats,
          pullsTriggered: stats.pullsTriggered,
          pulledFiles: stats.pulledFiles.map((p) => basename(p)),
          bytesPulled: stats.bytesPulled,
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
          bytesPulled: 0,
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
