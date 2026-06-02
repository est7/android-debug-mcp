import { pullFile as adbPullFile } from "../../../adb/evidence.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../../types.ts";
import {
  listDeviceLogFiles,
  shouldKeepByFilenameDate as shouldKeepByFilenameDateWithPattern,
} from "../device_files.ts";
import { type PoppoHttpQuery, PoppoHttpQuerySchema, matchPoppoHttpRecord } from "./match.ts";
import { previewPoppoHttpRecord } from "./preview.ts";
import { type PoppoHttpRecord, parsePoppoHttpLine } from "./record.ts";
import { redactPoppoHttpRecord } from "./redact.ts";

/**
 * v2-G Phase 4 concrete `EvidenceSource`: Poppo's `http_*.jsonl` HTTP-logging
 * interceptor output (schema rev4 at
 * `submodulepoppo/docs/projects/http-log-jsonl-schema.md`).
 *
 * Reads from `/sdcard/Android/data/<packageName>/files/http-logs/` — the
 * external files dir is `adb pull`-able without `run-as` or root. The same
 * source impl works for both Poppo (`com.baitu.poppo`) and Vone
 * (`com.baitu.vone`) because both ship the same interceptor under the
 * shared `poppo-vone` profile; the per-package path comes from
 * `EvidenceContext.packageName` (Phase 4 amendment to Phase 3's ctx shape).
 *
 * Policy modules:
 *   - `record.ts` — zod schema + `parsePoppoHttpLine` (`.passthrough()` per
 *     schema § 兼容性规则, hard-reject `v !== 1`).
 *   - `match.ts`  — `PoppoHttpQuerySchema`, `matchPoppoHttpRecord`,
 *     `derivePoppoHttpOutcome` (R4 cascade).
 *   - `redact.ts` — Q6 hardcoded redaction policy.
 *
 * Phase 3 contract amendments this source needs:
 *   - `bindSession` — clamps the agent's `tsMsRange.from` to at least
 *     `ctx.sessionStartMs` so cross-run records in the same retention
 *     window don't leak (codex Phase 4 audit R1).
 *   - `sortKey`     — `[tsMs, runId, seq]` per schema's reader contract
 *     (codex Phase 4 audit R2; lex-paginated via the cursor's sort variant).
 */

const SOURCE_ID = "poppo_http" as const;

/** Device path of the producer's external files dir for `packageName`. */
function deviceLogsDir(packageName: string): string {
  return `/sdcard/Android/data/${packageName}/files/http-logs`;
}

const FILENAME_PATTERN = /^http_(\d{4}-\d{2}-\d{2})_(\d+)\.jsonl$/;

/**
 * One-day-buffered filename-date filter (schema § Q5+: filename uses device
 * local date; sessions that span midnight need the buffer).
 *
 * When `deviceTimezone` is null (device prop was unreadable at start), we
 * skip the date filter entirely — listing all `http_*.jsonl` is a small
 * over-fetch but correctness-safe. Producer's retention (3 days / 100 MiB)
 * keeps the worst case bounded.
 */
export function shouldKeepByFilenameDate(
  filename: string,
  sessionStartMs: number,
  deviceTimezone: string | null,
): boolean {
  return shouldKeepByFilenameDateWithPattern(
    filename,
    FILENAME_PATTERN,
    sessionStartMs,
    deviceTimezone,
  );
}

export const poppoHttpSource: EvidenceSource = {
  id: SOURCE_ID,

  querySchema: PoppoHttpQuerySchema,

  async listDeviceFiles(ctx: EvidenceContext): Promise<readonly DeviceFileEntry[]> {
    const dir = deviceLogsDir(ctx.packageName);
    return await listDeviceLogFiles(ctx.deviceSerial, dir, (n) =>
      shouldKeepByFilenameDate(n, ctx.sessionStartMs, ctx.deviceTimezone),
    );
  },

  async pullFile(
    ctx: EvidenceContext,
    deviceFile: DeviceFileEntry,
    localPath: string,
  ): Promise<void> {
    await adbPullFile(ctx.deviceSerial, deviceFile.path, localPath);
  },

  parseLine(line: string): ParsedRecord | null {
    return parsePoppoHttpLine(line);
  },

  matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean {
    return matchPoppoHttpRecord(record as PoppoHttpRecord, query as PoppoHttpQuery);
  },

  /**
   * v0.4.0 Block A "no fetch-all" enforcement. poppo_http's dataset can
   * accumulate thousands of records per session (heartbeats every ~10s)
   * with single records reaching ~700 KB (i18n / large list responses).
   * The agent must opt into at least one positive filter or `tsMsRange`.
   *
   * `excludeHeartbeat` is deliberately NOT counted: it is a *negative*
   * filter that lets every non-heartbeat record through, which can still
   * be all-traffic-since-session-start.
   */
  validateNarrowingFilter(query: EvidenceQuery): string | null {
    const q = query as PoppoHttpQuery;
    const hasPositive =
      (q.pathPrefix !== undefined && q.pathPrefix !== "/") ||
      q.methodIn !== undefined ||
      q.outcome !== undefined ||
      q.tsMsRange !== undefined ||
      q.hostContains !== undefined ||
      q.durationMsGte !== undefined ||
      q.errorTypeIn !== undefined;
    if (hasPositive) return null;
    return (
      "search_evidence({source:'poppo_http'}) requires at least one narrowing filter: " +
      "pathPrefix, methodIn, outcome, tsMsRange, hostContains, durationMsGte, or errorTypeIn. " +
      "excludeHeartbeat alone does not narrow. " +
      "For 'records around an event', use extract_evidence_context (auto-injects tsMsRange from a marker)."
    );
  },

  redactForBundle(record: ParsedRecord): ParsedRecord {
    return redactPoppoHttpRecord(record as PoppoHttpRecord);
  },

  /**
   * v2-G.1 Block B — agent-facing preview. Truncates `body.text` /
   * `body.decoded` hotspots on request + response envelopes, leaves all
   * other fields intact. See `preview.ts` for the algorithm + thresholds.
   * Runtime wraps the returned record as `{...result.record, _meta:{preview:{...}}}`
   * before emit; the `_meta` reservation invariant fires on both raw page
   * records (parseLine output) and the hook's output (this function's
   * return), per Phase 1 audit refinement.
   */
  previewForAgent(record: ParsedRecord, opts) {
    return previewPoppoHttpRecord(record, opts);
  },

  /**
   * R1 — clamp `tsMsRange.from` to at least `ctx.sessionStartMs` WHEN the
   * agent provided `tsMsRange`. The producer's retention can include records
   * from app process runs that happened before the current MCP session
   * started, so when the agent IS doing time-window filtering, the floor
   * keeps cross-session records out.
   *
   * v2-G.1 Round 1 amendment (codex STOP 2026-05-28 #2): do NOT synthesize
   * a partial `tsMsRange` for agent queries that omit it. v0.5.0 behavior
   * was to inject `{tsMsRange:{from:sessionStartMs}}` for any narrowing
   * query, but Block A tightening (Q8) requires effective parsedQuery to
   * preserve the schema invariant "tsMsRange absent OR {from,to} both
   * bounded with window <= 24h". Synthesizing a single-from range would
   * violate that invariant downstream.
   *
   * Agents that need the session floor must explicitly pass `tsMsRange`
   * with both bounds; agents using `pathPrefix` / `methodIn` / etc. without
   * `tsMsRange` get no implicit time window — narrowingFilter already
   * accepts those positive fields as sufficient.
   */
  bindSession(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery {
    const q = query as PoppoHttpQuery;
    if (q.tsMsRange === undefined) return query;
    return {
      ...q,
      tsMsRange: {
        from: Math.max(q.tsMsRange.from, ctx.sessionStartMs),
        to: q.tsMsRange.to,
      },
    } as EvidenceQuery;
  },

  /**
   * R2 — `(tsMs, runId, seq)` per schema § "MCP 消费指南" reader contract.
   * `(runId, seq)` is the unique stable key per the schema; `tsMs` is the
   * primary sort. Runtime sorts the matched record buffer lex by this
   * tuple before paginating.
   */
  sortKey(record: ParsedRecord): readonly (string | number)[] {
    const r = record as PoppoHttpRecord;
    return [r.tsMs, r.runId, r.seq];
  },
};
