import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDomainError } from "../mcp/toolError.ts";
import { type SearchCursor, decodeCursor, encodeCursor } from "./cursor.ts";
import { readLinesFrom } from "./line_reader.ts";

/** logcat levels, ascending severity. `S` (silent) is not a filterable input. */
export const LOG_LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_AGGREGATE_GROUP_BYS = ["level", "tag", "pid"] as const;
export type LogAggregateGroupBy = (typeof LOG_AGGREGATE_GROUP_BYS)[number];

const LEVEL_RANK: Record<string, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, S: 6 };

/** When one log line alone overflows the response budget, its message is cut here. */
const OVERSIZE_MESSAGE_CAP = 8_000;

/** A logcat entry as surfaced by `search_logs` — the query-relevant subset of a logcat.jsonl line. */
export interface LogEntry {
  readonly tsRaw: string;
  readonly rawLineNo: number;
  readonly buffer: string;
  readonly level: string;
  readonly tag: string;
  readonly pid: number;
  readonly tid: number;
  readonly message: string;
  readonly truncatedSuspect?: boolean;
}

export interface SearchOptions {
  readonly query?: string;
  readonly level?: LogLevel;
  readonly buffer?: string;
  readonly sinceTs?: string;
  readonly beforeMark?: string;
  readonly afterMark?: string;
  readonly tags?: readonly string[];
  readonly excludeTags?: readonly string[];
  readonly pids?: readonly number[];
  readonly limit: number;
  readonly cursor?: string;
  readonly aggregate?: {
    readonly groupBy: LogAggregateGroupBy;
    readonly top?: number;
  };
}

export interface LogAggregate {
  readonly group: string;
  readonly count: number;
}

export interface SearchResult {
  readonly entries: LogEntry[];
  /** Total logcat.jsonl lines read across the paginated sequence so far. */
  readonly scanned: number;
  /** Matching entries returned in THIS page. */
  readonly matched: number;
  readonly nextCursor?: string;
  readonly groupBy?: LogAggregateGroupBy;
  readonly counts?: LogAggregate[];
  readonly groupsTotal?: number;
  readonly otherCount?: number;
  /** True only when a single entry overflowed the budget and its message was cut. */
  readonly truncated?: boolean;
  readonly truncationMessage?: string;
}

/**
 * Search a run's `logcat.jsonl`, streaming from the cursor position.
 *
 * `charBudget` keeps the page within {@link RESPONSE_CHAR_LIMIT}: entries are
 * collected until the next one would overflow it, at which point the page ends
 * with an exact `nextCursor` — so the budget is enforced WITHOUT dropping
 * already-returned entries (which would desync the cursor). The single abnormal
 * case — one log line whose own size exceeds the budget — is included with its
 * `message` cut and `truncated` set (§ G-5: never silently halve data).
 */
export async function searchLogs(
  runDir: string,
  opts: SearchOptions,
  charBudget: number,
): Promise<SearchResult> {
  const start: SearchCursor = opts.cursor ? decodeCursor(opts.cursor) : { offset: 0, scanned: 0 };
  const afterOffset =
    opts.afterMark !== undefined ? await resolveMarkOffset(runDir, opts.afterMark) : null;
  const beforeOffset =
    opts.beforeMark !== undefined ? await resolveMarkOffset(runDir, opts.beforeMark) : null;
  const queryLc = opts.query?.toLowerCase();
  const minRank = opts.level ? (LEVEL_RANK[opts.level] ?? 0) : 0;
  const tagSet = opts.tags ? new Set(opts.tags) : undefined;
  const excludeTagSet = opts.excludeTags ? new Set(opts.excludeTags) : undefined;
  const pidSet = opts.pids ? new Set(opts.pids) : undefined;

  const aggregate = opts.aggregate;
  if (aggregate !== undefined) {
    return aggregateLogs(runDir, opts, aggregate, {
      afterOffset,
      beforeOffset,
      minRank,
      queryLc,
      tagSet,
      excludeTagSet,
      pidSet,
      start,
    });
  }

  const entries: LogEntry[] = [];
  let scanned = start.scanned;
  let runningSize = 0;
  let truncated = false;
  let more = false;
  let resumeOffset = start.offset;

  for await (const { offset, text } of readLinesFrom(join(runDir, "logcat.jsonl"), start.offset)) {
    if (entries.length >= opts.limit) {
      more = true;
      resumeOffset = offset;
      break;
    }
    scanned++;
    const entry = parseLine(text);
    const lineEnd = offset + Buffer.byteLength(text, "utf8") + 1;
    if (
      entry === null ||
      !matches(entry, offset, {
        afterOffset,
        beforeOffset,
        minRank,
        opts,
        queryLc,
        tagSet,
        excludeTagSet,
        pidSet,
      })
    ) {
      resumeOffset = lineEnd;
      continue;
    }
    const size = JSON.stringify(entry).length;
    if (entries.length > 0 && runningSize + size > charBudget) {
      // This entry would overflow the page — stop before it; the cursor
      // re-reads it on the next call.
      more = true;
      resumeOffset = offset;
      break;
    }
    if (entries.length === 0 && size > charBudget) {
      // A single line bigger than the whole budget: include it cut, flag it.
      entries.push(cutMessage(entry));
      truncated = true;
    } else {
      entries.push(entry);
    }
    runningSize += size;
    resumeOffset = lineEnd;
  }

  return {
    entries,
    scanned,
    matched: entries.length,
    ...(more ? { nextCursor: encodeCursor({ offset: resumeOffset, scanned }) } : {}),
    ...(truncated
      ? {
          truncated: true,
          truncationMessage:
            "A log line exceeded the response size limit and its message was cut. " +
            "Narrow the search with `level` / `query`, or read logcat.jsonl in the run folder directly.",
        }
      : {}),
  };
}

interface AggregateContext {
  readonly afterOffset: number | null;
  readonly beforeOffset: number | null;
  readonly minRank: number;
  readonly queryLc: string | undefined;
  readonly tagSet: ReadonlySet<string> | undefined;
  readonly excludeTagSet: ReadonlySet<string> | undefined;
  readonly pidSet: ReadonlySet<number> | undefined;
  readonly start: SearchCursor;
}

async function aggregateLogs(
  runDir: string,
  opts: SearchOptions,
  aggregate: NonNullable<SearchOptions["aggregate"]>,
  ctx: AggregateContext,
): Promise<SearchResult> {
  const counts = new Map<string, number>();
  let scanned = ctx.start.scanned;
  let matched = 0;

  for await (const { offset, text } of readLinesFrom(
    join(runDir, "logcat.jsonl"),
    ctx.start.offset,
  )) {
    scanned++;
    const entry = parseLine(text);
    if (
      entry === null ||
      !matches(entry, offset, {
        afterOffset: ctx.afterOffset,
        beforeOffset: ctx.beforeOffset,
        minRank: ctx.minRank,
        opts,
        queryLc: ctx.queryLc,
        tagSet: ctx.tagSet,
        excludeTagSet: ctx.excludeTagSet,
        pidSet: ctx.pidSet,
      })
    ) {
      continue;
    }
    matched++;
    const key = aggregateKey(entry, aggregate.groupBy);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const sorted = [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
  const visibleCounts = aggregate.top !== undefined ? sorted.slice(0, aggregate.top) : sorted;
  const visibleTotal = visibleCounts.reduce((sum, item) => sum + item.count, 0);
  return {
    entries: [],
    scanned,
    matched,
    groupBy: aggregate.groupBy,
    counts: visibleCounts,
    groupsTotal: sorted.length,
    otherCount: matched - visibleTotal,
  };
}

function aggregateKey(entry: LogEntry, groupBy: LogAggregateGroupBy): string {
  switch (groupBy) {
    case "level":
      return entry.level;
    case "tag":
      return entry.tag;
    case "pid":
      return String(entry.pid);
  }
}

interface MatchContext {
  readonly afterOffset: number | null;
  readonly beforeOffset: number | null;
  readonly minRank: number;
  readonly opts: SearchOptions;
  readonly queryLc: string | undefined;
  readonly tagSet: ReadonlySet<string> | undefined;
  readonly excludeTagSet: ReadonlySet<string> | undefined;
  readonly pidSet: ReadonlySet<number> | undefined;
}

function matches(entry: LogEntry, offset: number, ctx: MatchContext): boolean {
  if (ctx.afterOffset !== null && offset < ctx.afterOffset) return false;
  if (ctx.beforeOffset !== null && offset >= ctx.beforeOffset) return false;
  if (ctx.opts.buffer !== undefined && entry.buffer !== ctx.opts.buffer) return false;
  if ((LEVEL_RANK[entry.level] ?? 0) < ctx.minRank) return false;
  if (ctx.tagSet !== undefined && !ctx.tagSet.has(entry.tag)) return false;
  if (ctx.excludeTagSet?.has(entry.tag)) return false;
  if (ctx.pidSet !== undefined && !ctx.pidSet.has(entry.pid)) return false;
  if (ctx.opts.sinceTs !== undefined && entry.tsRaw < ctx.opts.sinceTs) return false;
  if (ctx.queryLc !== undefined && !entry.message.toLowerCase().includes(ctx.queryLc)) return false;
  return true;
}

function cutMessage(entry: LogEntry): LogEntry {
  return {
    ...entry,
    message: `${entry.message.slice(0, OVERSIZE_MESSAGE_CAP)}…[message cut: ${entry.message.length} chars]`,
  };
}

/** Parse one logcat.jsonl line; a malformed / non-log line returns null and is skipped. */
function parseLine(text: string): LogEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  if (typeof obj.tsRaw !== "string" || typeof obj.message !== "string") return null;
  return {
    tsRaw: obj.tsRaw,
    rawLineNo: typeof obj.rawLineNo === "number" ? obj.rawLineNo : 0,
    buffer: typeof obj.buffer === "string" ? obj.buffer : "",
    level: typeof obj.level === "string" ? obj.level : "",
    tag: typeof obj.tag === "string" ? obj.tag : "",
    pid: typeof obj.pid === "number" ? obj.pid : 0,
    tid: typeof obj.tid === "number" ? obj.tid : 0,
    message: obj.message,
    ...(obj.truncatedSuspect === true ? { truncatedSuspect: true } : {}),
  };
}

/**
 * Resolve a mark name to the `logcat.jsonl` byte offset captured when the mark
 * was written (`mark_event` records `logcatOffset`). The LAST mark with the
 * name wins — a re-marked name resolves to its most recent placement. A null
 * `logcatOffset` (mark set before any log line) resolves to 0.
 */
async function resolveMarkOffset(runDir: string, markName: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch {
    throw markNotFound(markName);
  }
  let offset: number | null = null;
  let found = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "mark" && obj.name === markName) {
      found = true;
      offset = typeof obj.logcatOffset === "number" ? obj.logcatOffset : 0;
    }
  }
  if (!found) throw markNotFound(markName);
  return offset ?? 0;
}

function markNotFound(markName: string): ToolDomainError {
  return new ToolDomainError(
    "mark_not_found",
    `No mark named "${markName}" was recorded in this run.`,
    { mark: markName },
  );
}
