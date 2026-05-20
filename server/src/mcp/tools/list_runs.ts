import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { enumerateRuns } from "../../store/locate.ts";
import { resolveRunRoot } from "../../store/paths.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok } from "./_shared.ts";

/** Pagination cursor (§ G-3): the sort key of the last run on the previous page. */
interface RunsCursor {
  readonly lastStartedAt: string;
  readonly lastRunId: string;
}

function encodeCursor(cursor: RunsCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

function decodeCursor(raw: string): RunsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new ToolDomainError("invalid_cursor", "The cursor is not a valid list_runs cursor.");
  }
  const lastStartedAt = (parsed as { lastStartedAt?: unknown } | null)?.lastStartedAt;
  const lastRunId = (parsed as { lastRunId?: unknown } | null)?.lastRunId;
  if (typeof lastStartedAt !== "string" || typeof lastRunId !== "string") {
    throw new ToolDomainError("invalid_cursor", "The cursor is not a valid list_runs cursor.");
  }
  return { lastStartedAt, lastRunId };
}

const inputSchema = z
  .object({
    cursor: z.string().min(1, "cursor must be non-empty").optional(),
    limit: z
      .number()
      .int()
      .min(1, "limit must be >= 1")
      .max(100, "limit must be <= 100")
      .default(20),
  })
  .strict();

const runBriefSchema = z
  .object({
    runId: z.string(),
    runRoot: z.string(),
    packageName: z.string(),
    deviceSerial: z.string(),
    userId: z.number().int(),
    status: z.enum(["active", "degraded", "stopped", "aborted"]),
    startedAt: z.string(),
    closedAt: z.string().nullable(),
    crashFound: z.boolean(),
  })
  .strict();

const outputSchema = z
  .object({
    runs: z.array(runBriefSchema),
    nextCursor: z.string().optional(),
    hasMore: z.boolean(),
    totalCount: z.number().int(),
  })
  .strict();

const description = [
  "List debug runs found under the server's run root, newest first, paginated.",
  "",
  "Use when: the agent wants to see what runs exist — to pick a runId for `get_run_summary` / `search_logs`, or to confirm an orphan was recovered to `aborted`.",
  "Args: optional `cursor` (opaque, from a prior `nextCursor`); `limit` (1-100, default 20).",
  "Returns: `{runs[], nextCursor?, hasMore, totalCount}`. Each run carries `{runId, runRoot, packageName, deviceSerial, userId, status, startedAt, closedAt, crashFound}`, sorted by `startedAt` descending.",
  "Errors: `invalid_cursor` for a malformed cursor.",
].join("\n");

export function registerListRuns(server: McpServer, _manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_list_runs",
    {
      title: "List debug runs",
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
      const { runRoot } = resolveRunRoot();
      const briefs = (await enumerateRuns(runRoot)).map((e) => ({
        runId: e.metadata.runId,
        runRoot: e.metadata.runRoot,
        packageName: e.metadata.packageName,
        deviceSerial: e.metadata.deviceSerial,
        userId: e.metadata.userId,
        status: e.metadata.status,
        startedAt: e.metadata.startedAt,
        closedAt: e.metadata.closedAt,
        crashFound: e.metadata.crashFound,
      }));
      // Stable order: startedAt DESC, runId DESC as the tiebreak — the same
      // key the cursor encodes, so pagination cannot skip or repeat a run.
      briefs.sort(
        (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
      );

      const after = input.cursor !== undefined ? decodeCursor(input.cursor) : null;
      const remaining = after === null ? briefs : briefs.filter((b) => sortsAfter(b, after));
      const page = remaining.slice(0, input.limit);
      const hasMore = remaining.length > input.limit;
      const last = page[page.length - 1];

      return ok({
        runs: page,
        hasMore,
        totalCount: briefs.length,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeCursor({ lastStartedAt: last.startedAt, lastRunId: last.runId }) }
          : {}),
      });
    },
  );
}

/** True when `brief` sorts strictly after the cursor position in startedAt-DESC, runId-DESC order. */
function sortsAfter(brief: { startedAt: string; runId: string }, cursor: RunsCursor): boolean {
  if (brief.startedAt !== cursor.lastStartedAt) return brief.startedAt < cursor.lastStartedAt;
  return brief.runId < cursor.lastRunId;
}
