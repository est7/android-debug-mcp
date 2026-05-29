import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type GfxInfoDigest,
  type MemInfoDigest,
  collectGfxInfo,
  collectMemInfo,
  resetGfxInfo,
} from "../../adb/perf.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, sessionStatusSchema, touch } from "./_shared.ts";

const perfKindSchema = z.enum(["gfxinfo", "meminfo"]);

const inputSchema = z
  .object({
    runId: runIdInput,
    kinds: z.array(perfKindSchema).min(1).max(2).optional(),
    raw: z.boolean().optional(),
    reset: z.boolean().optional(),
  })
  .strict();

const percentilesSchema = z
  .object({
    p50: z.number().optional(),
    p90: z.number().optional(),
    p95: z.number().optional(),
    p99: z.number().optional(),
  })
  .strict();

const gfxInfoSchema = z
  .object({
    totalFrames: z.number().int().nullable(),
    jankyFrames: z.number().int().nullable(),
    jankyPercent: z.number().nullable(),
    percentilesMs: percentilesSchema,
    raw: z.string().optional(),
  })
  .strict();

const memInfoSchema = z
  .object({
    totalPssKb: z.number().int().nullable(),
    nativeHeapKb: z.number().int().nullable(),
    dalvikHeapKb: z.number().int().nullable(),
    graphicsKb: z.number().int().nullable(),
    stackKb: z.number().int().nullable(),
    codeKb: z.number().int().nullable(),
    raw: z.string().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    packageName: z.string(),
    collectedAt: z.string(),
    reset: z.boolean(),
    gfxinfo: gfxInfoSchema.optional(),
    meminfo: memInfoSchema.optional(),
    warnings: z.array(z.string()).optional(),
    sessionStatus: sessionStatusSchema,
  })
  .strict();

type PerfKind = z.output<typeof perfKindSchema>;

const DEFAULT_KINDS: readonly PerfKind[] = ["gfxinfo", "meminfo"];

const description = [
  "Collect a live performance snapshot for the active session's app via host-side dumpsys probes.",
  "",
  "Use when: the agent needs a compact jank or memory digest around an interaction, for example reset counters, perform a scroll, then read `gfxinfo` jank and `meminfo` PSS without pulling a full trace.",
  'Args: `runId`; `kinds` optional array of `"gfxinfo"` and/or `"meminfo"` (default both); `raw` optional boolean (default false) to include full dumpsys text; `reset` optional boolean (default false) to reset gfxinfo counters after collecting the snapshot. `reset:true` requires `gfxinfo` in `kinds`.',
  "Returns: `{runId, packageName, collectedAt, reset, gfxinfo?, meminfo?, warnings?, sessionStatus}`. Default output is parsed digest only; `raw:true` adds raw dumpsys text under each requested kind.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session's device has dropped; `query_malformed` when `kinds` contains duplicates or `reset:true` is requested without `gfxinfo`; `adb_not_found` when the adb binary is missing; `adb_command_failed` when a dumpsys command fails.",
].join("\n");

export function registerPerfSnapshot(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_perf_snapshot",
    {
      title: "Collect performance snapshot",
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
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      const kinds = normalizeKinds(input.kinds);
      const includeRaw = input.raw === true;
      const reset = input.reset === true;
      if (reset && !kinds.includes("gfxinfo")) {
        throw new ToolDomainError(
          "query_malformed",
          "`reset:true` requires `gfxinfo` in `kinds`; meminfo has no reset counter.",
          { runId: input.runId },
        );
      }

      const warnings: string[] = [];
      let gfxinfo: (GfxInfoDigest & { raw?: string }) | undefined;
      let meminfo: (MemInfoDigest & { raw?: string }) | undefined;

      if (kinds.includes("gfxinfo")) {
        const collected = await collectGfxInfo(session.deviceSerial, session.packageName);
        gfxinfo = includeRaw ? { ...collected.digest, raw: collected.raw } : collected.digest;
        warnings.push(...collected.warnings);
      }
      if (kinds.includes("meminfo")) {
        const collected = await collectMemInfo(session.deviceSerial, session.packageName);
        meminfo = includeRaw ? { ...collected.digest, raw: collected.raw } : collected.digest;
        warnings.push(...collected.warnings);
      }
      if (reset) {
        await resetGfxInfo(session.deviceSerial, session.packageName);
      }

      const collectedAt = new Date().toISOString();
      await session.appendCommand({
        tool: "perf_snapshot",
        adb: adbSummary(session.packageName, kinds, reset),
        kinds,
        reset,
        raw: includeRaw,
      });
      await session.appendEvent({ type: "perf_snapshot", kinds, reset });

      return ok({
        runId: session.runId,
        packageName: session.packageName,
        collectedAt,
        reset,
        ...(gfxinfo !== undefined ? { gfxinfo } : {}),
        ...(meminfo !== undefined ? { meminfo } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        sessionStatus: session.healthSnapshot(),
      });
    },
  );
}

function normalizeKinds(kinds: readonly PerfKind[] | undefined): PerfKind[] {
  const requested = kinds === undefined ? [...DEFAULT_KINDS] : [...kinds];
  if (new Set(requested).size !== requested.length) {
    throw new ToolDomainError("query_malformed", "`kinds` must not contain duplicates.");
  }
  return requested;
}

function adbSummary(packageName: string, kinds: readonly PerfKind[], reset: boolean): string {
  const commands: string[] = [];
  if (kinds.includes("gfxinfo")) commands.push(`dumpsys gfxinfo ${packageName}`);
  if (kinds.includes("meminfo")) commands.push(`dumpsys meminfo ${packageName}`);
  if (reset) commands.push(`dumpsys gfxinfo ${packageName} reset`);
  return commands.join("; ");
}
