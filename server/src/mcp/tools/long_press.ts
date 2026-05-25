import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputSwipe } from "../../adb/input.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { coord, ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

/**
 * `android_debug_long_press` — coord-based long press (design lock § Q10–Q12).
 *
 * `adb shell input swipe <x> <y> <x> <y> <durationMs>` with no displacement is
 * the canonical long-press on Android (same path mobile-mcp takes). The tool
 * deliberately mirrors v1 `tap`'s envelope: pure coordinates in, `{ts}` out,
 * same failure catalog. Element-driven long-press is an agent-side composition
 * (`list_elements` → pick coords → `long_press`); the server stays minimal.
 */

const inputSchema = z
  .object({
    runId: runIdInput,
    x: coord("x"),
    y: coord("y"),
    durationMs: z
      .number()
      .int("durationMs must be an integer")
      .min(1, "durationMs must be >= 1")
      .max(10_000, "durationMs must be <= 10000")
      .default(500),
    label: z.string().min(1, "label must be non-empty").max(200, "label too long").optional(),
  })
  .strict();

const outputSchema = z.object({ ts: z.string() }).strict();

const description = [
  "Long-press the screen at given coordinates. Equivalent to a swipe with no movement.",
  "",
  "Use when: the agent needs to trigger a long-press context (e.g. open a context menu, raise a tooltip) at a specific coordinate. For a plain tap use `android_debug_tap`; for a moving gesture use `android_debug_swipe`.",
  "Args: `runId`; `x` / `y` pixel coordinates (0-20000); optional `durationMs` (1-10000, default 500); optional `label` recorded in events.jsonl.",
  "Returns: `{ts}` — the ISO timestamp the long-press was recorded at.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `adb_not_found` when the adb binary is missing; `adb_command_failed` when the adb command fails.",
].join("\n");

export function registerLongPress(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_long_press",
    {
      title: "Long-press a coordinate",
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

      // Zero-displacement swipe with the supplied duration — this is how
      // `input swipe` exposes long-press; `input` has no dedicated subcommand.
      await inputSwipe(
        session.deviceSerial,
        { x: input.x, y: input.y },
        { x: input.x, y: input.y },
        input.durationMs,
      );

      await session.appendCommand({
        tool: "long_press",
        adb: `input swipe ${input.x} ${input.y} ${input.x} ${input.y} ${input.durationMs}`,
      });
      const ts = await session.appendEvent(
        input.label !== undefined
          ? {
              type: "long_press",
              x: input.x,
              y: input.y,
              durationMs: input.durationMs,
              label: input.label,
            }
          : {
              type: "long_press",
              x: input.x,
              y: input.y,
              durationMs: input.durationMs,
            },
      );
      return ok({ ts });
    },
  );
}
