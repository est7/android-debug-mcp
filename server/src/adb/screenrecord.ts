import { open, stat } from "node:fs/promises";
import { extractVideoFrames } from "../media/video_frames.ts";
import { runAdb } from "./adb.ts";
import { AdbExecError } from "./errors.ts";

const STOP_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const START_READY_MS = 3_000;

export interface ScreenRecordingStartInput {
  readonly recordingId: string;
  readonly deviceSerial: string;
  readonly remotePath: string;
  readonly artifactPath: string;
  readonly startedAt: string;
  readonly maxDurationSeconds: number;
  readonly bitRate: number;
}

export interface ActiveScreenRecording extends ScreenRecordingStartInput {
  readonly remotePid: number;
}

export interface ScreenRecordingStopResult {
  readonly stoppedAt: string;
  readonly durationMs: number;
  readonly byteSize: number;
  readonly forced: boolean;
  readonly framePaths: readonly string[];
  readonly warnings: readonly string[];
}

/** Start `screenrecord` detached on-device so later MCP calls can keep driving the UI. */
export async function startScreenRecording(
  input: ScreenRecordingStartInput,
): Promise<ActiveScreenRecording> {
  const remoteCommand = [
    "nohup",
    "setsid",
    "screenrecord",
    "--bit-rate",
    String(input.bitRate),
    "--time-limit",
    String(input.maxDurationSeconds),
    input.remotePath,
    ">/dev/null",
    "2>&1",
    "</dev/null",
    "&",
    "echo $!",
  ].join(" ");
  const args = ["-s", input.deviceSerial, "shell", remoteCommand] as const;
  const result = await runAdb(args, { timeoutMs: 10_000 });
  const pidText = /(?:^|\n)(\d+)\s*$/.exec(result.stdout)?.[1];
  const remotePid = pidText === undefined ? Number.NaN : Number.parseInt(pidText, 10);
  if (!Number.isSafeInteger(remotePid) || remotePid <= 0) {
    throw new AdbExecError(
      args,
      -1,
      result.stdout,
      result.stderr || "screenrecord did not return a remote pid",
    );
  }
  const recording = { ...input, remotePid };
  const deadline = Date.now() + START_READY_MS;
  while (Date.now() < deadline) {
    if (!(await isRemoteScreenRecordAlive(recording))) break;
    if (await remoteFileHasBytes(recording)) return recording;
    await delay(POLL_INTERVAL_MS);
  }
  await discardScreenRecording(recording);
  throw new AdbExecError(
    args,
    -1,
    result.stdout,
    "screenrecord did not produce a non-empty MP4 before the readiness deadline",
  );
}

/** Stop, pull, validate, and remove the device-side temporary MP4. Safe to retry after pull failure. */
export async function stopScreenRecording(
  recording: ActiveScreenRecording,
): Promise<ScreenRecordingStopResult> {
  if (await isRemoteScreenRecordAlive(recording)) {
    await runAdb(
      ["-s", recording.deviceSerial, "shell", "kill", "-2", String(recording.remotePid)],
      { timeoutMs: 5_000, allowNonZero: true },
    );
  }

  let forced = false;
  const deadline = Date.now() + STOP_GRACE_MS;
  while ((await isRemoteScreenRecordAlive(recording)) && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
  }
  if (await isRemoteScreenRecordAlive(recording)) {
    forced = true;
    await runAdb(
      ["-s", recording.deviceSerial, "shell", "kill", "-9", String(recording.remotePid)],
      { timeoutMs: 5_000, allowNonZero: true },
    );
  }

  await runAdb(
    ["-s", recording.deviceSerial, "pull", recording.remotePath, recording.artifactPath],
    { timeoutMs: 60_000 },
  );

  let byteSize: number;
  try {
    byteSize = await validateMp4(recording.artifactPath);
  } finally {
    await runAdb(["-s", recording.deviceSerial, "shell", "rm", "-f", recording.remotePath], {
      timeoutMs: 5_000,
      allowNonZero: true,
    }).catch(() => undefined);
  }

  const stoppedAt = new Date().toISOString();
  const frameResult = await extractVideoFrames({
    videoPath: recording.artifactPath,
    framesDir: `${recording.artifactPath.slice(0, -".mp4".length)}-frames`,
    maxDurationSeconds: recording.maxDurationSeconds,
  });
  return {
    stoppedAt,
    durationMs: Math.max(0, Date.parse(stoppedAt) - Date.parse(recording.startedAt)),
    byteSize,
    forced,
    framePaths: frameResult.framePaths,
    warnings: [
      ...(forced ? ["screenrecord required SIGKILL; MP4 finalization may be incomplete"] : []),
      ...frameResult.warnings,
    ],
  };
}

/** Best-effort teardown used when a session closes after recording finalization failed. */
export async function discardScreenRecording(recording: ActiveScreenRecording): Promise<void> {
  if (await isRemoteScreenRecordAlive(recording).catch(() => false)) {
    await runAdb(
      ["-s", recording.deviceSerial, "shell", "kill", "-9", String(recording.remotePid)],
      { timeoutMs: 5_000, allowNonZero: true },
    ).catch(() => undefined);
  }
  await runAdb(["-s", recording.deviceSerial, "shell", "rm", "-f", recording.remotePath], {
    timeoutMs: 5_000,
    allowNonZero: true,
  }).catch(() => undefined);
}

async function isRemoteScreenRecordAlive(recording: ActiveScreenRecording): Promise<boolean> {
  const result = await runAdb(
    ["-s", recording.deviceSerial, "shell", "cat", `/proc/${recording.remotePid}/cmdline`],
    { timeoutMs: 5_000, allowNonZero: true },
  );
  return result.exitCode === 0 && result.stdout.includes("screenrecord");
}

async function remoteFileHasBytes(recording: ActiveScreenRecording): Promise<boolean> {
  const result = await runAdb(
    ["-s", recording.deviceSerial, "shell", "test", "-s", recording.remotePath],
    { timeoutMs: 5_000, allowNonZero: true },
  );
  return result.exitCode === 0;
}

async function validateMp4(path: string): Promise<number> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 12 || header.toString("ascii", 4, 8) !== "ftyp") {
      throw new AdbExecError(
        ["pull", "<screenrecord>", path],
        -1,
        "",
        "pulled screen recording is not a finalized MP4 (missing ftyp box)",
      );
    }
  } finally {
    await handle.close();
  }
  return (await stat(path)).size;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
