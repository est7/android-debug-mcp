import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAppPids,
  getDeviceProps,
  getExitInfo,
  getForegroundActivity,
  getPackageVersion,
} from "../../adb/app.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ok, requireConnectedSession, runIdInput, sessionStatusSchema } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
  })
  .strict();

const exitInfoSchema = z
  .object({
    timestamp: z.string().nullable(),
    pid: z.number().int().nullable(),
    reason: z.string().nullable(),
    description: z.string().nullable(),
  })
  .strict();

const outputSchema = z
  .object({
    activity: z.string().nullable(),
    foreground: z.boolean(),
    pids: z.array(z.number().int()),
    versionName: z.string().nullable(),
    versionCode: z.string().nullable(),
    abi: z.string().nullable(),
    exitInfo: z.array(exitInfoSchema),
    sessionStatus: sessionStatusSchema,
  })
  .strict();

const description = [
  "Read a live snapshot of the active session's app: foreground activity, process ids, installed version, abi, recent exit-info, and session health.",
  "",
  "Use when: the agent needs to know whether the app is running / foregrounded, or wants the post-mortem `exit-info` after a suspected crash.",
  "Args: `runId`.",
  "Returns: `{activity, foreground, pids, versionName, versionCode, abi, exitInfo[], sessionStatus}`. This tool is read-only and does not reset the session's idle timer.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the session's device has dropped; `adb_not_found` when the adb binary is missing; `adb_command_failed` when an adb command fails.",
].join("\n");

export function registerGetAppState(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_get_app_state",
    {
      title: "Get app state",
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
      const session = requireConnectedSession(manager, input.runId);
      // Read-only: intentionally does NOT touch the idle timer (§ timers —
      // idle reset is for interaction, not queries).

      const [foreground, pids, version, deviceProps, exitInfo] = await Promise.all([
        getForegroundActivity(session.deviceSerial, session.packageName),
        getAppPids(session.deviceSerial, session.packageName),
        getPackageVersion(session.deviceSerial, session.packageName, session.userId),
        getDeviceProps(session.deviceSerial),
        getExitInfo(session.deviceSerial, session.packageName),
      ]);
      session.setPids(pids);

      return ok({
        activity: foreground.activity,
        foreground: foreground.foreground,
        pids,
        versionName: version.versionName,
        versionCode: version.versionCode,
        abi: deviceProps.abi,
        exitInfo,
        sessionStatus: session.healthSnapshot(),
      });
    },
  );
}
