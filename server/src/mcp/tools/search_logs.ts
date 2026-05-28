import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LOG_AGGREGATE_GROUP_BYS,
  type SearchOptions,
  searchLogs,
} from "../../search/search_logs.ts";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import { RESPONSE_CHAR_LIMIT } from "../constants.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput } from "./_shared.ts";

/** Chars reserved for the response envelope (counts, cursor, truncation note). */
const ENVELOPE_RESERVE = 2_000;

const markName = z
  .string()
  .regex(/^[a-z0-9_.-]{1,80}$/, "mark name must match ^[a-z0-9_.-]{1,80}$");

const inputSchema = z
  .object({
    runId: runIdInput,
    query: z.string().min(1, "query must be non-empty").max(2_000, "query too long").optional(),
    level: z.enum(["V", "D", "I", "W", "E", "F"]).optional(),
    buffer: z.enum(["main", "system", "crash"]).optional(),
    sinceTs: z.string().min(1, "sinceTs must be non-empty").max(64, "sinceTs too long").optional(),
    beforeMark: markName.optional(),
    afterMark: markName.optional(),
    tags: z
      .array(z.string().min(1, "tag must be non-empty").max(256, "tag too long"))
      .min(1, "tags must list at least one tag")
      .max(100, "tags list too long")
      .optional(),
    excludeTags: z
      .array(z.string().min(1, "tag must be non-empty").max(256, "tag too long"))
      .min(1, "excludeTags must list at least one tag")
      .max(100, "excludeTags list too long")
      .optional(),
    limit: z
      .number()
      .int()
      .min(1, "limit must be >= 1")
      .max(500, "limit must be <= 500")
      .default(100),
    cursor: z.string().min(1, "cursor must be non-empty").optional(),
    count: z.literal(true).optional(),
    groupBy: z.enum(LOG_AGGREGATE_GROUP_BYS).optional(),
    top: z.number().int().min(1, "top must be >= 1").max(100, "top must be <= 100").optional(),
  })
  .strict();

const logEntrySchema = z
  .object({
    tsRaw: z.string(),
    rawLineNo: z.number().int(),
    buffer: z.string(),
    level: z.string(),
    tag: z.string(),
    pid: z.number().int(),
    tid: z.number().int(),
    message: z.string(),
    truncatedSuspect: z.boolean().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    entries: z.array(logEntrySchema),
    scanned: z.number().int(),
    matched: z.number().int(),
    groupBy: z.enum(LOG_AGGREGATE_GROUP_BYS).optional(),
    counts: z.array(z.object({ group: z.string(), count: z.number().int() }).strict()).optional(),
    groupsTotal: z.number().int().optional(),
    otherCount: z.number().int().optional(),
    nextCursor: z.string().optional(),
    truncated: z.boolean().optional(),
    truncationMessage: z.string().optional(),
  })
  .strict();

const description = [
  "Search a debug run's parsed logcat (`logcat.jsonl`), streaming and paginated.",
  "",
  "Use when: the agent needs log lines matching a pattern, a severity, or a window relative to a `mark_event` marker — for an active or a finalized run.",
  'Args: `runId`; at least one of `query` / `level` / `sinceTs` / `beforeMark` / `afterMark` / `tags` (the call requires at least one narrowing filter on EVERY call — `buffer`, `excludeTags`, and `cursor` alone do NOT count). `query` is a case-insensitive substring of the message; `level` is a severity threshold — `W` returns W/E/F; `buffer` (`main`/`system`/`crash`) defaults to `main`; `sinceTs` is a device-clock `MM-DD HH:MM:SS.mmm` prefix, kept lines `>=` it; `beforeMark` / `afterMark` name a `mark_event` mark — the logcat window before/after where that mark was placed; `tags` keeps only entries whose `tag` exactly matches one of these (case-sensitive); `excludeTags` drops entries whose `tag` matches (applied after `tags`); `limit` (1-500, default 100); `cursor` resumes pagination — pass the SAME positive filter from the first page on every subsequent page. Aggregation mode: `count:true` with `groupBy:"level"|"tag"|"pid"` scans the narrowed set and returns counts instead of log entries; optional `top` (1-100) keeps the largest groups. Aggregation does not accept `cursor`.',
  "Returns: normal mode `{entries[], scanned, matched, nextCursor?, truncated?, truncationMessage?}`. `nextCursor` present means more lines remain. `truncated` means one oversized log line had its message cut. Aggregation mode returns `{entries:[], scanned, matched, groupBy, counts:[{group,count}], groupsTotal, otherCount}` where `matched` is the total narrowed log-line count before grouping and `otherCount` is the count outside the returned top groups.",
  "Errors: `run_missing` for an unknown runId; `query_underspecified` when the call carries no positive narrowing filter (cursor / buffer / excludeTags alone do not count); `query_malformed` when aggregation fields are inconsistent; `invalid_cursor` for a malformed cursor; `mark_not_found` when `beforeMark` / `afterMark` names a mark not in the run.",
].join("\n");

export function registerSearchLogs(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_search_logs",
    {
      title: "Search run logs",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      // v0.4.0 Block A "no fetch-all": logcat is the noisiest stream in the
      // run; a no-filter call returns up to `limit` lines truncated by the
      // response char budget — still mostly noise to the agent. Require at
      // least one positive narrowing field on EVERY call, paginated or not.
      // `buffer` alone does NOT count (default `main` is already the largest
      // buffer); `excludeTags` does NOT count (negative filter). A `cursor`
      // does NOT count either — the cursor codec (server/src/search/cursor.ts)
      // carries `{offset, scanned}` only and binds no filter state, so a
      // hand-crafted cursor would bypass the gate. The convention "pass the
      // same filters across pages" (per the tool description) keeps page-2+
      // calls narrowed; the gate fires the same way on each page.
      if (
        input.query === undefined &&
        input.level === undefined &&
        input.sinceTs === undefined &&
        input.beforeMark === undefined &&
        input.afterMark === undefined &&
        input.tags === undefined
      ) {
        throw new ToolDomainError(
          "query_underspecified",
          "search_logs requires at least one narrowing filter on every call: query, level, sinceTs, beforeMark, afterMark, or tags. buffer / excludeTags / cursor alone do not narrow; on paginated calls pass the same filter as the first page.",
          { tool: "search_logs" },
        );
      }
      if ((input.count === true) !== (input.groupBy !== undefined)) {
        throw new ToolDomainError(
          "query_malformed",
          "search_logs aggregation requires count:true and groupBy together.",
          { tool: "search_logs" },
        );
      }
      if (input.top !== undefined && input.count !== true) {
        throw new ToolDomainError(
          "query_malformed",
          "search_logs top is only valid with count:true aggregation.",
          { tool: "search_logs" },
        );
      }
      if (input.count === true && input.cursor !== undefined) {
        throw new ToolDomainError(
          "query_malformed",
          "search_logs aggregation scans the narrowed set and does not accept cursor pagination.",
          { tool: "search_logs" },
        );
      }
      const runDir = await resolveRunDir(manager, input.runId);
      const opts: SearchOptions = {
        limit: input.limit,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.buffer !== undefined ? { buffer: input.buffer } : {}),
        ...(input.sinceTs !== undefined ? { sinceTs: input.sinceTs } : {}),
        ...(input.beforeMark !== undefined ? { beforeMark: input.beforeMark } : {}),
        ...(input.afterMark !== undefined ? { afterMark: input.afterMark } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.excludeTags !== undefined ? { excludeTags: input.excludeTags } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.count === true && input.groupBy !== undefined
          ? {
              aggregate: {
                groupBy: input.groupBy,
                ...(input.top !== undefined ? { top: input.top } : {}),
              },
            }
          : {}),
      };
      const result = await searchLogs(runDir, opts, RESPONSE_CHAR_LIMIT - ENVELOPE_RESERVE);
      return ok({
        entries: result.entries,
        scanned: result.scanned,
        matched: result.matched,
        ...(result.groupBy !== undefined ? { groupBy: result.groupBy } : {}),
        ...(result.counts !== undefined ? { counts: result.counts } : {}),
        ...(result.groupsTotal !== undefined ? { groupsTotal: result.groupsTotal } : {}),
        ...(result.otherCount !== undefined ? { otherCount: result.otherCount } : {}),
        ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.truncationMessage !== undefined
          ? { truncationMessage: result.truncationMessage }
          : {}),
      });
    },
  );
}
