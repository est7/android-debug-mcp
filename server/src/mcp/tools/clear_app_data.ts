import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { clearAppData } from "../../adb/app.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    confirm: z.boolean(),
  })
  .strict();

const outputSchema = z
  .object({
    cleared: z.boolean(),
    detail: z.string(),
  })
  .strict();

const description = [
  "Wipe the active session's app data via `pm clear` — a DESTRUCTIVE operation that erases accounts, databases, and preferences for the package.",
  "",
  "Use when: the agent deliberately wants a clean-slate app state. This is a separate tool from `android_debug_app_control` precisely so the destructive hint is unambiguous.",
  "Args: `runId`; `confirm` — must be the boolean `true`, an explicit acknowledgement that data loss is intended.",
  "Returns: `{cleared, detail}` — `cleared` reflects whether `pm clear` reported success.",
  "Errors: `confirmation_required` when `confirm` is not `true`; `no_active_session` for an unknown runId; `device_disconnected` when the session's device has dropped.",
].join("\n");

export function registerClearAppData(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_clear_app_data",
    {
      title: "Clear app data (destructive)",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      if (input.confirm !== true) {
        throw new ToolDomainError(
          "confirmation_required",
          "clear_app_data erases all app data; pass confirm:true to proceed.",
        );
      }
      touch(session);

      const result = await clearAppData(session.deviceSerial, session.packageName, session.userId);
      await session.appendCommand({ tool: "clear_app_data", detail: result.detail });
      await session.appendEvent({
        type: "lifecycle",
        phase: "clear_app_data",
        cleared: result.ok,
        detail: result.detail,
      });
      return ok({ cleared: result.ok, detail: result.detail });
    },
  );
}
