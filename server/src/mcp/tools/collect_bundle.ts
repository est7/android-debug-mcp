import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createBundle } from "../../bundle/bundle.ts";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import { readMetadata } from "../../store/metadata.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    logs: z.enum(["none", "redacted", "raw"]).default("none"),
    acknowledgeUnredacted: z.boolean().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    bundlePath: z.string(),
    byteSize: z.number().int(),
    logs: z.enum(["none", "redacted", "raw"]),
  })
  .strict();

const description = [
  "Package a debug run's folder into a `.tar.gz` archive for sharing or archival.",
  "",
  "Use when: a run is complete and the agent wants a single transferable artifact of its evidence.",
  "Args: `runId`; `logs` — `none` (default; no logcat), `redacted` (logcat.jsonl with credentials scrubbed), or `raw` (verbatim logcat.jsonl + logcat.raw.txt); `acknowledgeUnredacted` — required `true` when `logs` is `raw`.",
  "Returns: `{bundlePath, byteSize, logs}` — the archive lands in `<runRoot>/bundles/`.",
  "Errors: `run_missing` for an unknown runId; `confirmation_required` when `logs` is `raw` without `acknowledgeUnredacted: true` (the unredacted-export leak gate, § C-4).",
].join("\n");

export function registerCollectBundle(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_collect_bundle",
    {
      title: "Collect run bundle",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      // § C-4 leak gate: a raw (unredacted) export must be explicitly acknowledged.
      if (input.logs === "raw" && input.acknowledgeUnredacted !== true) {
        throw new ToolDomainError(
          "confirmation_required",
          'logs:"raw" exports unredacted logcat — pass acknowledgeUnredacted:true to confirm, or use logs:"redacted".',
          { runId: input.runId },
        );
      }
      const runDir = await resolveRunDir(manager, input.runId);
      const metadata = await readMetadata(runDir);
      const result = await createBundle({
        runDir,
        runId: input.runId,
        bundlesDir: join(metadata.runRoot, "bundles"),
        logs: input.logs,
      });
      return ok({
        bundlePath: result.bundlePath,
        byteSize: result.byteSize,
        logs: result.logs,
      });
    },
  );
}
