import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAdb } from "../../adb/adb.ts";
import {
  getAppPids,
  getCurrentUser,
  getDeviceProps,
  getPackageVersion,
  launchApp,
} from "../../adb/app.ts";
import { listDevices } from "../../adb/devices.ts";
import { getGitInfo } from "../../host/git.ts";
import { DEFAULT_LOGCAT_BUFFER_SIZE } from "../../logcat/spawn.ts";
import type { SessionManager } from "../../session/manager.ts";
import { IdentityError, assertSafePackageName } from "../../store/identity.ts";
import { resolveRunRoot } from "../../store/paths.ts";
import { clearClosedRuns } from "../../store/run.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok } from "./_shared.ts";

const inputSchema = z
  .object({
    packageName: z.string().min(1, "packageName required").max(255),
    deviceSerial: z.string().min(1).max(128).optional(),
    userId: z.union([z.number().int().min(0).max(999), z.literal("current")]).optional(),
    projectRoot: z.string().min(1).max(4096).optional(),
    clearLocalRunLogs: z.boolean().optional(),
    clearDeviceLogcat: z.boolean().optional(),
    launchOnStart: z.boolean().optional(),
    logcatBufferSize: z.string().min(1).max(16).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    runDir: z.string(),
    runRoot: z.string(),
    runRootSource: z.enum(["explicit", "env", "cwd-git", "fallback"]),
    deviceSerial: z.string(),
    userId: z.number().int(),
    packageName: z.string(),
    pid: z.number().int().nullable(),
    launchDetail: z.string().nullable(),
    versionName: z.string().nullable(),
    versionCode: z.string().nullable(),
    clearedRunCount: z.number().int(),
  })
  .strict();

const description = [
  "Start a debug session for an Android package on a connected device: acquire the singleton lock, materialize the run folder, capture app/device/git provenance, and optionally launch the app.",
  "",
  "Use when: the agent is about to debug an app and needs a `runId` to anchor every subsequent tool call.",
  'Args: `packageName` (required); optional `deviceSerial` (auto-picks the sole connected device when omitted), `userId` (number or "current", default "current"), `projectRoot` (for run-root resolution + git provenance), `clearLocalRunLogs`, `clearDeviceLogcat`, `launchOnStart`, `logcatBufferSize`.',
  "Returns: `{runId, runDir, runRoot, runRootSource, deviceSerial, userId, packageName, pid, launchDetail, versionName, versionCode, clearedRunCount}`. `pid` is null when the app was not launched or the launch failed (the run still starts).",
  "Errors: `no_device` / `ambiguous_device` / `device_disconnected` for device resolution; `singleton_violation` when this (device,user,package) tuple already has an active session; `invalid_identity` for a malformed packageName; `adb_not_found` / `adb_command_failed` when the adb binary is missing or an adb command fails.",
].join("\n");

export function registerStartSession(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_start_session",
    {
      title: "Start debug session",
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
      // Validate the only user-controlled identity up front, BEFORE it is used
      // as path material by clearClosedRuns / createRunDir — otherwise an
      // IdentityError leaks as a protocol error instead of the documented
      // `invalid_identity` domain error (P3-P2-4).
      guardIdentity(() => assertSafePackageName(input.packageName));

      const deviceSerial = await resolveDevice(input.deviceSerial);
      const userId = await resolveUserId(deviceSerial, input.userId);
      const { runRoot, source } = resolveRunRoot(
        input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {},
      );

      let clearedRunCount = 0;
      if (input.clearLocalRunLogs === true) {
        clearedRunCount = (await clearClosedRuns(runRoot, input.packageName)).length;
      }

      const session = await startWithIdentityGuard(manager, {
        deviceSerial,
        userId,
        packageName: input.packageName,
        runRoot,
        runRootSource: source,
      });

      // Everything past this point runs AFTER the session is registered and
      // its tuple lock is held. A throw here must abort the session, else the
      // caller has no runId to stop it and the tuple stays locked (P3-P1-1).
      try {
        const [version, deviceProps] = await Promise.all([
          getPackageVersion(deviceSerial, input.packageName, userId),
          getDeviceProps(deviceSerial),
        ]);
        const git = getGitInfo(input.projectRoot ?? process.cwd());
        await session.patchMetadata((current) => ({
          ...current,
          app: { versionName: version.versionName, versionCode: version.versionCode },
          device: {
            model: deviceProps.model,
            apiLevel: deviceProps.apiLevel,
            abi: deviceProps.abi,
            buildFingerprint: deviceProps.buildFingerprint,
          },
          git: { sha: git.sha, dirty: git.dirty },
          logcatBuffer: {
            ...current.logcatBuffer,
            requested: input.logcatBufferSize ?? null,
          },
        }));

        if (input.clearDeviceLogcat === true) {
          await runAdb(["-s", deviceSerial, "logcat", "-c"], {
            timeoutMs: 8_000,
            allowNonZero: true,
          });
        }

        let pid: number | null = null;
        let launchDetail: string | null = null;
        if (input.launchOnStart === true) {
          const launch = await launchApp(deviceSerial, input.packageName, userId);
          launchDetail = launch.detail;
          if (launch.launched) {
            // Best-effort: the forked process may not have a pid yet. A null
            // pid is acceptable — the agent can re-query via get_app_state.
            const pids = await getAppPids(deviceSerial, input.packageName);
            pid = pids.length > 0 ? (pids[0] as number) : null;
          }
          // Phase 3 decision: a failed launch does NOT roll back the session
          // (a `{launched:false}` result is normal). An unexpected *throw*,
          // however, is handled by the abort path below.
          await session.appendEvent({
            type: "lifecycle",
            phase: "launch_on_start",
            launched: launch.launched,
            detail: launch.detail,
            pid,
          });
          if (pid !== null) session.setPids([pid]);
        }

        // Spawn the logcat dual channel. `-T <session start>` means a slightly
        // late spawn still replays from session start, so doing this after
        // launchOnStart (to seed the launched pid) loses nothing.
        await session.startLogcat({
          requestedBufferSize: input.logcatBufferSize ?? DEFAULT_LOGCAT_BUFFER_SIZE,
          seedPids: pid !== null ? [pid] : [],
        });

        await session.appendEvent({
          type: "lifecycle",
          phase: "session_start",
          deviceSerial,
          userId,
          packageName: input.packageName,
        });

        return ok({
          runId: session.runId,
          runDir: session.runDir,
          runRoot,
          runRootSource: source,
          deviceSerial,
          userId,
          packageName: input.packageName,
          pid,
          launchDetail,
          versionName: version.versionName,
          versionCode: version.versionCode,
          clearedRunCount,
        });
      } catch (err) {
        // Best-effort: free the lock + run folder + tuple index so the caller
        // (which never received a runId) is not blocked from retrying.
        await manager.abort(session).catch(() => undefined);
        throw err;
      }
    },
  );
}

/** Run `fn`, converting any `IdentityError` into a typed `invalid_identity`
 * domain error so it surfaces as a tool result rather than a protocol error. */
function guardIdentity<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof IdentityError) {
      throw new ToolDomainError("invalid_identity", err.message, { field: err.field });
    }
    throw err;
  }
}

async function startWithIdentityGuard(
  manager: SessionManager,
  input: Parameters<SessionManager["start"]>[0],
) {
  try {
    return await manager.start(input);
  } catch (err) {
    if (err instanceof IdentityError) {
      throw new ToolDomainError("invalid_identity", err.message, {
        field: err.field,
      });
    }
    throw err;
  }
}

async function resolveDevice(requested: string | undefined): Promise<string> {
  const devices = await listDevices();
  if (requested !== undefined) {
    const found = devices.find((d) => d.deviceSerial === requested);
    if (!found) {
      throw new ToolDomainError(
        "device_disconnected",
        `Device ${requested} is not visible to adb.`,
        { requested, visible: devices.map((d) => d.deviceSerial) },
      );
    }
    if (found.state !== "device") {
      throw new ToolDomainError(
        "device_disconnected",
        `Device ${requested} is in state "${found.state}", not usable.`,
        { requested, state: found.state },
      );
    }
    return requested;
  }
  const usable = devices.filter((d) => d.state === "device");
  if (usable.length === 0) {
    throw new ToolDomainError("no_device", "No usable device is connected.", {
      visible: devices.map((d) => ({ deviceSerial: d.deviceSerial, state: d.state })),
    });
  }
  if (usable.length > 1) {
    throw new ToolDomainError(
      "ambiguous_device",
      "Multiple devices are connected; pass an explicit deviceSerial.",
      { candidates: usable.map((d) => d.deviceSerial) },
    );
  }
  return (usable[0] as { deviceSerial: string }).deviceSerial;
}

async function resolveUserId(
  deviceSerial: string,
  requested: number | "current" | undefined,
): Promise<number> {
  if (typeof requested === "number") return requested;
  // undefined or "current" → query the device.
  return getCurrentUser(deviceSerial);
}
