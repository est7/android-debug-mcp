import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import type { Metadata } from "../../store/metadata.ts";
import { finalizeSummary } from "../../summary/finalize.ts";
import { RESPONSE_CHAR_LIMIT } from "../constants.ts";
import { registerDebugTool } from "../register.ts";
import { runIdInput, sessionStatusSchema } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    packageName: z.string(),
    deviceSerial: z.string(),
    userId: z.number().int(),
    status: z.enum(["active", "degraded", "stopped", "aborted"]),
    startedAt: z.string(),
    closedAt: z.string().nullable(),
    app: z
      .object({ versionName: z.string().nullable(), versionCode: z.string().nullable() })
      .strict(),
    device: z
      .object({
        model: z.string().nullable(),
        apiLevel: z.number().int().nullable(),
        abi: z.string().nullable(),
        buildFingerprint: z.string().nullable(),
        // v2-G additive (Q5+); see store/metadata.ts.
        timezone: z.string().nullable(),
      })
      .strict(),
    git: z.object({ sha: z.string().nullable(), dirty: z.boolean().nullable() }).strict(),
    crashFound: z.boolean(),
    counts: z
      .object({
        events: z.number().int(),
        commands: z.number().int(),
        logcatLines: z.number().int(),
        crashes: z.number().int(),
      })
      .strict(),
    crashes: z.array(
      z.object({ type: z.string(), marker: z.string(), rawLineNo: z.number().int() }).strict(),
    ),
    sessionStatus: sessionStatusSchema,
    summaryPath: z.string(),
    truncated: z.boolean().optional(),
    truncationMessage: z.string().optional(),
  })
  .strict();

const description = [
  "Render the full Markdown report for a debug run and return it alongside a structured metadata object.",
  "",
  "Use when: a run is done (or being inspected mid-flight) and the agent wants the device / app / git provenance, counts, crash list, and event timeline in one place.",
  "Args: `runId` — an active or finalized run.",
  "Returns: `content[0].text` is the Markdown report; `structuredContent` carries `{runId, packageName, status, app, device, git, counts, crashes[], sessionStatus, summaryPath, ...}`. `summary.md` is (re)written into the run folder as a side effect.",
  "Errors: `run_missing` for an unknown runId.",
].join("\n");

/** A finalized run has no live Session; derive its health snapshot from metadata. */
function deriveSessionStatus(m: Metadata): z.infer<typeof sessionStatusSchema> {
  return {
    device: m.status === "degraded" ? "degraded" : "connected",
    logcat: m.closedAt !== null ? "stopped" : "running",
    startedAt: m.startedAt,
    lastLogAt: null,
    lastCommandAt: null,
  };
}

export function registerGetRunSummary(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_get_run_summary",
    {
      title: "Get run summary",
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
      const runDir = await resolveRunDir(manager, input.runId);
      const live = manager.listActive().find((s) => s.runId === input.runId);
      const { markdown, data } = await finalizeSummary(runDir);
      const m = data.metadata;

      const structured = {
        runId: m.runId,
        packageName: m.packageName,
        deviceSerial: m.deviceSerial,
        userId: m.userId,
        status: m.status,
        startedAt: m.startedAt,
        closedAt: m.closedAt,
        app: m.app,
        device: m.device,
        git: m.git,
        crashFound: m.crashFound,
        counts: data.counts,
        crashes: data.crashes.map((c) => ({
          type: c.type,
          marker: c.marker,
          rawLineNo: c.rawLineNo,
        })),
        sessionStatus: live ? live.healthSnapshot() : deriveSessionStatus(m),
        summaryPath: join(runDir, "summary.md"),
      };

      // § G-5 backstop: the report itself is bounded (timeline capped in
      // render.ts), but a run with huge event payloads could still overrun.
      // Trim the Markdown text — never the structured metadata — and flag it.
      let text = markdown;
      const envelope = JSON.stringify(structured).length;
      if (text.length + envelope > RESPONSE_CHAR_LIMIT) {
        const room = Math.max(0, RESPONSE_CHAR_LIMIT - envelope - 200);
        text = `${text.slice(0, room)}\n\n_…report truncated to fit the response limit; read summary.md in the run folder for the full report._`;
        return {
          structuredContent: {
            ...structured,
            truncated: true,
            truncationMessage: `The Markdown report exceeded ${RESPONSE_CHAR_LIMIT} chars; it was trimmed. The complete report is at ${structured.summaryPath}.`,
          },
          content: [{ type: "text", text }],
        };
      }
      return { structuredContent: structured, content: [{ type: "text", text }] };
    },
  );
}
