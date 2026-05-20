import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractCrashContext } from "../../search/crash_context.ts";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import { RESPONSE_CHAR_LIMIT } from "../constants.ts";
import { registerDebugTool } from "../register.ts";
import { ok, runIdInput } from "./_shared.ts";

/** Chars reserved for the response envelope around the snippet. */
const ENVELOPE_RESERVE = 3_000;

const inputSchema = z
  .object({
    runId: runIdInput,
    crashIndex: z
      .number()
      .int("crashIndex must be an integer")
      .min(0, "crashIndex must be >= 0")
      .default(0),
    beforeLines: z
      .number()
      .int("beforeLines must be an integer")
      .min(0, "beforeLines must be >= 0")
      .max(1_000, "beforeLines must be <= 1000")
      .default(200),
    afterLines: z
      .number()
      .int("afterLines must be an integer")
      .min(0, "afterLines must be >= 0")
      .max(1_000, "afterLines must be <= 1000")
      .default(200),
  })
  .strict();

const outputSchema = z
  .object({
    crashCount: z.number().int(),
    crashIndex: z.number().int().optional(),
    type: z.enum(["java", "native", "anr"]).optional(),
    marker: z.string().optional(),
    rawLineNo: z.number().int().optional(),
    mainException: z.string().nullable().optional(),
    topFrame: z.string().nullable().optional(),
    snippet: z.string().optional(),
    snippetRange: z.object({ from: z.number().int(), to: z.number().int() }).strict().optional(),
    truncated: z.boolean().optional(),
    truncationMessage: z.string().optional(),
  })
  .strict();

const description = [
  "Extract the raw-log context around a crash recorded in a debug run's `crash.jsonl`.",
  "",
  "Use when: a run is suspected to have crashed and the agent wants the FATAL / signal / ANR stack with surrounding log lines.",
  "Args: `runId`; optional `crashIndex` (0-based, default 0 — the first crash); `beforeLines` / `afterLines` (0-1000, default 200) — the raw-log window around the crash marker line.",
  "Returns: `{crashCount, crashIndex?, type?, marker?, rawLineNo?, mainException?, topFrame?, snippet?, snippetRange?, truncated?}`. A run with no crash returns `{crashCount: 0}` and nothing else — not an error.",
  "Errors: `run_missing` for an unknown runId; `invalid_argument` when `crashIndex` exceeds the run's crash count.",
].join("\n");

export function registerExtractCrashContext(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_extract_crash_context",
    {
      title: "Extract crash context",
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
      const context = await extractCrashContext(
        runDir,
        {
          crashIndex: input.crashIndex,
          beforeLines: input.beforeLines,
          afterLines: input.afterLines,
        },
        RESPONSE_CHAR_LIMIT - ENVELOPE_RESERVE,
      );
      return ok({ ...context });
    },
  );
}
