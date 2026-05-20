import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputTap } from "../../adb/input.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { coord, ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    x: coord("x"),
    y: coord("y"),
    label: z.string().min(1, "label must be non-empty").max(200, "label too long").optional(),
  })
  .strict();

const outputSchema = z.object({ ts: z.string() }).strict();

const description = [
  "Tap a screen coordinate on the active session's device via `adb shell input tap`.",
  "",
  "Use when: driving a debug repro and a point on screen must be pressed — a button, a list row, a field.",
  "Args: `runId`; `x` / `y` pixel coordinates (0-20000); optional `label` describing the target (recorded in events.jsonl).",
  "Returns: `{ts}` — the ISO timestamp the tap was recorded at.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped.",
].join("\n");

export function registerTap(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_tap",
    {
      title: "Tap a coordinate",
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

      await inputTap(session.deviceSerial, input.x, input.y);

      await session.appendCommand({ tool: "tap", adb: `input tap ${input.x} ${input.y}` });
      const ts = await session.appendEvent(
        input.label !== undefined
          ? { type: "tap", x: input.x, y: input.y, label: input.label }
          : { type: "tap", x: input.x, y: input.y },
      );
      return ok({ ts });
    },
  );
}
