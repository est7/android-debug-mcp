import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const DEFAULT_MAX_DURATION_SECONDS = 10;
const DEFAULT_BIT_RATE = 12_000_000;

const inputSchema = z
  .object({
    runId: runIdInput,
    action: z.enum(["start", "stop"]),
    recordingId: z
      .string()
      .regex(/^[a-f0-9]{12}$/)
      .optional(),
    maxDurationSeconds: z.number().int().min(1).max(180).optional(),
    bitRate: z.number().int().min(1_000_000).max(100_000_000).optional(),
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    recordingId: z.string(),
    action: z.enum(["start", "stop"]),
    status: z.enum(["recording", "saved"]),
    startedAt: z.string(),
    maxDurationSeconds: z.number().int(),
    bitRate: z.number().int(),
    stoppedAt: z.string().optional(),
    videoPath: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    byteSize: z.number().int().nonnegative().optional(),
    forced: z.boolean().optional(),
    framePaths: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const description = [
  "Explicitly start or stop an MP4 screen recording for an active debug session.",
  "",
  "Use when: motion itself is evidence — transition timing, flicker, dropped frames, or an intermediate visual state — or the user explicitly asks for video. Do not record by default when a screenshot, UI dump, log, or structured evidence answers the question. Recording has privacy, storage, and device-performance cost. The recording is screen-only; protected/secure surfaces may be blank.",
  '`Args: `runId`; `action:"start"|"stop"`. Start accepts optional `maxDurationSeconds` (1-180, default 10) and `bitRate` (1,000,000-100,000,000, default 12,000,000), and rejects `recordingId`. Stop requires the exact `recordingId` returned by start and rejects start-only options. One recording may be active per run.',
  'Returns: start → `{runId, recordingId, action:"start", status:"recording", startedAt, maxDurationSeconds, bitRate}`; stop → the same identity plus `{action:"stop", status:"saved", stoppedAt, videoPath, framePaths, durationMs, byteSize, forced, warnings?}`. The MP4 and bounded ffmpeg-sampled PNG frames are stored under the run\'s `artifacts/` directory and included by `collect_bundle`. If ffmpeg is unavailable or extraction fails, the MP4 remains saved and `framePaths` is empty with a warning. `stop_session` automatically attempts to stop and save an omitted active recording.',
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `query_malformed` for action-specific argument misuse; `screen_recording_active` when start is called twice; `screen_recording_not_active` when stop has no matching active recording; `adb_not_found` when adb is missing; `adb_command_failed` when screenrecord, process stop, pull, or MP4 validation fails.",
].join("\n");

export function registerScreenRecording(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_screen_recording",
    {
      title: "Record screen repro",
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

      if (input.action === "start") {
        if (input.recordingId !== undefined) {
          throw malformed(input.runId, '`recordingId` is only valid for action:"stop".');
        }
        const recordingId = randomBytes(6).toString("hex");
        const maxDurationSeconds = input.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
        const bitRate = input.bitRate ?? DEFAULT_BIT_RATE;
        const startedAt = new Date().toISOString();
        const remotePath = `/sdcard/android-debug-mcp-${session.runId}-${recordingId}.mp4`;
        const artifactPath = join(session.runDir, "artifacts", `screenrecord-${recordingId}.mp4`);
        await session.appendCommand({
          tool: "screen_recording",
          action: "start",
          recordingId,
          adb: `screenrecord --bit-rate ${bitRate} --time-limit ${maxDurationSeconds} ${remotePath}`,
        });
        const recording = await session.beginScreenRecording({
          recordingId,
          deviceSerial: session.deviceSerial,
          remotePath,
          artifactPath,
          startedAt,
          maxDurationSeconds,
          bitRate,
        });
        await session.appendEvent({
          type: "screen_recording_started",
          recordingId,
          maxDurationSeconds,
          bitRate,
        });
        return ok({
          runId: session.runId,
          recordingId,
          action: "start" as const,
          status: "recording" as const,
          startedAt: recording.startedAt,
          maxDurationSeconds,
          bitRate,
        });
      }

      if (input.recordingId === undefined) {
        throw malformed(input.runId, '`recordingId` is required for action:"stop".');
      }
      if (input.maxDurationSeconds !== undefined || input.bitRate !== undefined) {
        throw malformed(
          input.runId,
          '`maxDurationSeconds` and `bitRate` are only valid for action:"start".',
        );
      }
      await session.appendCommand({
        tool: "screen_recording",
        action: "stop",
        recordingId: input.recordingId,
        adb: "kill -2 <screenrecord-pid>; adb pull <remote-mp4> <run-artifact>",
      });
      const { recording, result } = await session.stopScreenRecording(input.recordingId);
      await session.appendEvent({
        type: "screen_recording_saved",
        recordingId: recording.recordingId,
        videoPath: recording.artifactPath,
        byteSize: result.byteSize,
        durationMs: result.durationMs,
        forced: result.forced,
        framePaths: result.framePaths,
        reason: "explicit_stop",
      });
      return ok({
        runId: session.runId,
        recordingId: recording.recordingId,
        action: "stop" as const,
        status: "saved" as const,
        startedAt: recording.startedAt,
        maxDurationSeconds: recording.maxDurationSeconds,
        bitRate: recording.bitRate,
        stoppedAt: result.stoppedAt,
        videoPath: recording.artifactPath,
        durationMs: result.durationMs,
        byteSize: result.byteSize,
        forced: result.forced,
        framePaths: [...result.framePaths],
        ...(result.warnings.length > 0 ? { warnings: [...result.warnings] } : {}),
      });
    },
  );
}

function malformed(runId: string, message: string): ToolDomainError {
  return new ToolDomainError("query_malformed", message, { runId });
}
