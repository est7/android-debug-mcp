import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { forceStopApp, getAppPids, launchApp } from "../../adb/app.ts";
import type { SessionManager } from "../../session/manager.ts";
import type { Session } from "../../session/session.ts";
import { registerDebugTool } from "../register.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    action: z.enum(["launch", "restart", "stop"]),
  })
  .strict();

const outputSchema = z
  .object({
    action: z.enum(["launch", "restart", "stop"]),
    launched: z.boolean(),
    pids: z.array(z.number().int()),
    detail: z.string(),
  })
  .strict();

const description = [
  "Control the lifecycle of the active session's app: launch it, restart it (force-stop then launch), or stop it.",
  "",
  "Use when: the agent needs to bring the app to a known state during a debug run. Data-clearing is intentionally NOT here — use `android_debug_clear_app_data`.",
  "Args: `runId`; `action` one of `launch` | `restart` | `stop`.",
  "Returns: `{action, launched, pids, detail}` — `launched` is true when the app was (re)started, `pids` is the app's process ids observed afterwards.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session's device has dropped; `adb_command_failed` when an adb command fails. Launch failures are reported in `detail` with `launched:false` rather than thrown.",
].join("\n");

export function registerAppControl(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_app_control",
    {
      title: "Control app lifecycle",
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

      let launched = false;
      let detail: string;
      switch (input.action) {
        case "stop": {
          await forceStopApp(session.deviceSerial, session.packageName, session.userId);
          detail = "am force-stop";
          break;
        }
        case "restart": {
          await forceStopApp(session.deviceSerial, session.packageName, session.userId);
          const r = await launchApp(session.deviceSerial, session.packageName, session.userId);
          launched = r.launched;
          detail = `force-stop + ${r.detail}`;
          break;
        }
        default: {
          const r = await launchApp(session.deviceSerial, session.packageName, session.userId);
          launched = r.launched;
          detail = r.detail;
          break;
        }
      }

      const pids =
        input.action === "stop" ? [] : await getAppPids(session.deviceSerial, session.packageName);
      session.setPids(pids);

      await recordControl(session, input.action, launched, detail, pids);
      return ok({ action: input.action, launched, pids, detail });
    },
  );
}

async function recordControl(
  session: Session,
  action: string,
  launched: boolean,
  detail: string,
  pids: readonly number[],
): Promise<void> {
  await session.appendCommand({ tool: "app_control", action, detail });
  await session.appendEvent({
    type: "lifecycle",
    phase: "app_control",
    action,
    launched,
    pids: [...pids],
  });
}
