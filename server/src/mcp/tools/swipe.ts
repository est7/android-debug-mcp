import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputSwipe } from "../../adb/input.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { coord, ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    x1: coord("x1"),
    y1: coord("y1"),
    x2: coord("x2"),
    y2: coord("y2"),
    durationMs: z
      .number()
      .int("durationMs must be an integer")
      .min(1, "durationMs must be >= 1")
      .max(10_000, "durationMs must be <= 10000")
      .optional(),
  })
  .strict();

const outputSchema = z.object({ ts: z.string() }).strict();

const description = [
  "Swipe between two screen coordinates on the active session's device via `adb shell input swipe`.",
  "",
  "Use when: the agent needs to scroll a list, dismiss a sheet, or drag — any gesture between two points.",
  "Args: `runId`; start `x1`/`y1` and end `x2`/`y2` pixel coordinates (0-20000); optional `durationMs` (1-10000) for the gesture length.",
  "Returns: `{ts}` — the ISO timestamp the swipe was recorded at.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped.",
].join("\n");

export function registerSwipe(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_swipe",
    {
      title: "Swipe between coordinates",
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

      await inputSwipe(
        session.deviceSerial,
        { x: input.x1, y: input.y1 },
        { x: input.x2, y: input.y2 },
        input.durationMs,
      );

      const duration = input.durationMs !== undefined ? ` ${input.durationMs}` : "";
      const adb = `input swipe ${input.x1} ${input.y1} ${input.x2} ${input.y2}${duration}`;
      await session.appendCommand({ tool: "swipe", adb });
      const ts = await session.appendEvent(
        input.durationMs !== undefined
          ? {
              type: "swipe",
              x1: input.x1,
              y1: input.y1,
              x2: input.x2,
              y2: input.y2,
              durationMs: input.durationMs,
            }
          : { type: "swipe", x1: input.x1, y1: input.y1, x2: input.x2, y2: input.y2 },
      );
      return ok({ ts });
    },
  );
}
