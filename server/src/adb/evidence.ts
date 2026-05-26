import { runAdb } from "./adb.ts";

/**
 * adb thin wrappers used by v2-G evidence pulling. Kept separate from
 * `capture.ts` (screenshot / UI dump) because the lifecycle is different:
 * evidence files persist on the device across sessions (rolling JSONL logs)
 * and are pulled lazily on first need, whereas captures are produced and
 * immediately consumed by the same tool call.
 *
 * Both wrappers assume the caller has already resolved `deviceSerial` via
 * `start_session`; they do not re-validate connectivity. Failures surface as
 * `AdbExecError` (non-zero exit, structured by `runAdb`) — except for the
 * one well-defined "soft miss" case where `statMtimeMs` returns `null`: the
 * device file is absent (rotated away, never existed). That case is normal
 * during the listDeviceFiles → statMtime → pullFile pipeline: a candidate
 * file may rotate between listing and stat.
 */

/** Default ceiling for `adb shell stat -c %Y <file>`. Stat is fast on local fs. */
const STAT_TIMEOUT_MS = 5_000;

/**
 * Per Poppo HTTP log schema rev4, single files cap at ~20 MiB before rotation,
 * so a 30 s pull ceiling at 700 KiB/s (a pessimistic adb-over-USB floor) gives
 * ~3x headroom. Tests can override via the options object.
 */
const PULL_TIMEOUT_MS = 30_000;

export interface StatMtimeOptions {
  readonly timeoutMs?: number;
}

/**
 * Return mtime in epoch ms for `devicePath`, or `null` when the file does not
 * exist. Built on `adb shell stat -c %Y <path>` which prints epoch SECONDS on
 * GNU/coreutils-style stat; we multiply to ms for parity with `mtimeMs`
 * elsewhere.
 *
 * Missing-file detection is intentionally tolerant: `stat` on most Android
 * stat impls prints to stderr ("No such file or directory") and exits 1; some
 * BusyBox variants exit 0 with empty stdout. Both shapes map to `null`.
 *
 * The function does NOT distinguish "file missing" from "directory listed
 * stale entry" — both are normal between `listDeviceFiles` and the per-file
 * stat call. Callers should treat null as "skip this candidate."
 */
export async function statMtimeMs(
  deviceSerial: string,
  devicePath: string,
  opts: StatMtimeOptions = {},
): Promise<number | null> {
  const res = await runAdb(["-s", deviceSerial, "shell", "stat", "-c", "%Y", devicePath], {
    timeoutMs: opts.timeoutMs ?? STAT_TIMEOUT_MS,
    allowNonZero: true,
  });

  // Missing-file paths split by exit channel:
  //   * non-zero exit + GNU/toybox "No such file or directory" → null
  //   * non-zero exit + anything else (permission denied, device busy) → throw
  //   * zero exit + empty stdout → null (BusyBox stat for a missing path)
  const stdoutTrim = res.stdout.trim();
  if (res.exitCode !== 0) {
    if (looksLikeMissingFile(res.stderr)) return null;
    // A real adb / shell failure is not a soft miss — surface it so
    // search_evidence reports it instead of returning silently-empty results.
    throw new Error(
      `adb shell stat -c %Y ${devicePath} exited ${res.exitCode}: ${
        res.stderr.trim() || res.stdout.trim() || "<no output>"
      }`,
    );
  }
  if (stdoutTrim === "") return null;

  const seconds = Number.parseInt(stdoutTrim, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `adb shell stat -c %Y ${devicePath} returned unparseable mtime: "${stdoutTrim}"`,
    );
  }
  return seconds * 1000;
}

function looksLikeMissingFile(stderr: string): boolean {
  // GNU stat / toybox / busybox variants all converge on this phrase fragment.
  return /No such file or directory/i.test(stderr);
}

export interface PullFileOptions {
  readonly timeoutMs?: number;
}

/**
 * Pull `devicePath` to `localPath` via `adb pull`. Caller has already
 * ensured the parent dir of `localPath` exists (Phase 3 sourceDir helper).
 *
 * Throws `AdbExecError` on non-zero exit. We do NOT downgrade pull failures
 * to soft misses: by the time we call this, `statMtimeMs` confirmed the file
 * was present moments ago. A pull failure here means an actual adb / fs
 * problem the agent needs to see.
 */
export async function pullFile(
  deviceSerial: string,
  devicePath: string,
  localPath: string,
  opts: PullFileOptions = {},
): Promise<void> {
  await runAdb(["-s", deviceSerial, "pull", devicePath, localPath], {
    timeoutMs: opts.timeoutMs ?? PULL_TIMEOUT_MS,
  });
}
