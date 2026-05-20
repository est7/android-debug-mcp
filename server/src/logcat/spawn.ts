import type { ChildProcess } from "node:child_process";
import { runAdb, spawnAdb } from "../adb/adb.ts";

/**
 * Spawn the streaming `adb logcat` child for a session.
 *
 * Before spawning, the logcat ring buffer is grown (§ A·4 / § D-M2):
 * `-g` (read) → `-G <size>` (set) → `-g` (verify). The resize is best-effort —
 * a failure is reported in {@link LogcatBufferInfo.error} and the session
 * continues; it must not block capture.
 *
 * The streaming child is `adb logcat -b main,system,crash -v uid -v threadtime
 * -T <epoch> *:V`:
 *   - `-b main,system,crash` — app log + framework + native-crash buffers.
 *   - `-v uid -v threadtime` — uid column (API ≥ 30) + the stable threadtime layout.
 *   - `-T <epoch>` — start from the session's start time, so the pre-session
 *     ring-buffer contents are not replayed (§ D-M3).
 */

export const LOGCAT_BUFFERS = ["main", "system", "crash"] as const;
export const DEFAULT_LOGCAT_BUFFER_SIZE = "16M";

export interface LogcatBufferInfo {
  readonly requested: string;
  /** Raw `logcat -g` summary after the resize, or null when it could not be read. */
  readonly effective: string | null;
  readonly buffers: readonly string[];
  /** Non-null when the resize could not be confirmed; the session still runs. */
  readonly error: string | null;
}

export interface LogcatSpawnResult {
  readonly child: ChildProcess;
  readonly bufferInfo: LogcatBufferInfo;
}

export interface StartLogcatInput {
  readonly deviceSerial: string;
  /** e.g. "16M" / "32M" — from `start_session({logcatBufferSize})`. */
  readonly requestedBufferSize: string;
  /** Session start, seconds since epoch — passed to `logcat -T`. */
  readonly sinceEpochSec: number;
}

export async function startLogcat(input: StartLogcatInput): Promise<LogcatSpawnResult> {
  const bufferInfo = await resizeBuffer(input.deviceSerial, input.requestedBufferSize);
  const child = await spawnAdb([
    "-s",
    input.deviceSerial,
    "logcat",
    "-b",
    LOGCAT_BUFFERS.join(","),
    "-v",
    "uid",
    "-v",
    "threadtime",
    "-T",
    `${Math.floor(input.sinceEpochSec)}.000`,
    "*:V",
  ]);
  return { child, bufferInfo };
}

async function resizeBuffer(deviceSerial: string, requested: string): Promise<LogcatBufferInfo> {
  const base: Omit<LogcatBufferInfo, "effective" | "error"> = {
    requested,
    buffers: LOGCAT_BUFFERS,
  };
  try {
    const setResult = await runAdb(["-s", deviceSerial, "logcat", "-G", requested], {
      timeoutMs: 8_000,
      allowNonZero: true,
    });
    if (setResult.exitCode !== 0) {
      return {
        ...base,
        effective: null,
        error: `logcat -G ${requested} failed: ${firstLine(setResult.stderr) || `exit ${setResult.exitCode}`}`,
      };
    }
    const verify = await runAdb(["-s", deviceSerial, "logcat", "-g"], {
      timeoutMs: 8_000,
      allowNonZero: true,
    });
    if (verify.exitCode !== 0) {
      return { ...base, effective: null, error: "logcat -g (verify) failed" };
    }
    const effective = verify.stdout.trim();
    const error = confirmResize(requested, effective);
    return { ...base, effective, error };
  } catch (err) {
    return { ...base, effective: null, error: `logcat buffer resize threw: ${String(err)}` };
  }
}

/**
 * Loose check that the post-resize buffer is at least the requested size.
 * Returns an error string on a confirmed shortfall, null when it matches or
 * cannot be parsed (we do not fail a session over an unparseable `-g`).
 */
function confirmResize(requested: string, effectiveSummary: string): string | null {
  const wantBytes = parseSizeToBytes(requested);
  if (wantBytes === null) return null;
  // `-g` prints one `... ring buffer is N MiB (B bytes) ...` line per buffer;
  // take the smallest effective size across buffers.
  const sizes = [...effectiveSummary.matchAll(/\((\d+)\s*bytes\)/g)].map((m) =>
    Number.parseInt(m[1] as string, 10),
  );
  if (sizes.length === 0) return null;
  const smallest = Math.min(...sizes);
  if (smallest + 1 < wantBytes) {
    return `effective logcat buffer ${smallest} bytes is below requested ${wantBytes} bytes`;
  }
  return null;
}

function parseSizeToBytes(size: string): number | null {
  const m = /^(\d+)\s*([KMG])?B?$/i.exec(size.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unit = (m[2] ?? "").toUpperCase();
  const mult = unit === "G" ? 1024 ** 3 : unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return n * mult;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}
