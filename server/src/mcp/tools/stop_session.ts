import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { RunStatusSchema, readMetadata } from "../../store/metadata.ts";
import { finalizeSummary } from "../../summary/finalize.ts";
import { registerDebugTool } from "../register.ts";
import { ok, runIdInput } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput.optional(),
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    runDir: z.string(),
    status: RunStatusSchema,
    crashFound: z.boolean(),
    summary: z.string(),
  })
  .strict();

const description = [
  "Stop an active debug session: finalize its metadata, flush and close the run's jsonl streams, and release the global lock.",
  "",
  "Use when: a debug run is complete and the agent wants the run sealed on disk.",
  "Args: `runId` — optional; may be omitted only when exactly one session is active.",
  "Returns: `{runId, runDir, status, crashFound, summary}`. `summary` is a short stub in v1 Phase 3; the full report comes from `android_debug_get_run_summary`.",
  "Errors: `no_active_session` when nothing is running; `ambiguous_active_session` when `runId` is omitted but two or more sessions are active; `run_missing` when the given `runId` is unknown.",
].join("\n");

export function registerStopSession(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_stop_session",
    {
      title: "Stop debug session",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = manager.resolveForStop(input.runId);
      // The `session_stop` event + teardown both happen inside manager.stop(),
      // where the event write is best-effort so it can never block finalize.
      await manager.stop(session);
      const finalMeta = await readMetadata(session.runDir);
      // Write summary.md best-effort: the run is already sealed, so a render
      // failure must not fail the stop — get_run_summary regenerates it anyway.
      await finalizeSummary(session.runDir).catch(() => undefined);
      // Report the run's ACTUAL terminal status — a session degraded by a
      // device disconnect finalizes `degraded`, and `stop_session` must not
      // flatten that to `stopped` (it would diverge from metadata /
      // get_run_summary).
      return ok({
        runId: session.runId,
        runDir: session.runDir,
        status: finalMeta.status,
        crashFound: finalMeta.crashFound,
        summary: `Session ${session.runId} stopped (status=${finalMeta.status}). Full report: android_debug_get_run_summary.`,
      });
    },
  );
}
