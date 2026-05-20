import { runAdb } from "./adb.ts";

/**
 * App-scoped adb wrappers used by the Phase 3 session lifecycle tools.
 *
 * Every call that addresses an Android user takes an explicit `userId` and
 * threads `--user <id>` into the underlying command where the platform
 * supports it (§ D-M8). Parsers are deliberately lenient — adb / dumpsys
 * output drifts across OEM ROMs and API levels, so each function degrades to
 * a null / empty result rather than throwing on an unrecognized shape.
 */

export interface PackageVersion {
  readonly versionName: string | null;
  readonly versionCode: string | null;
}

export interface ForegroundActivity {
  /** `package/activity` of the resumed activity, or null when none resolved. */
  readonly activity: string | null;
  /** true when the resumed activity belongs to `packageName`. */
  readonly foreground: boolean;
}

export interface ExitInfoEntry {
  readonly timestamp: string | null;
  readonly pid: number | null;
  readonly reason: string | null;
  readonly description: string | null;
}

export interface DeviceProps {
  readonly model: string | null;
  readonly apiLevel: number | null;
  readonly abi: string | null;
  readonly buildFingerprint: string | null;
}

function userArgs(userId: number): string[] {
  return ["--user", String(userId)];
}

/** `am get-current-user` → the foreground Android user id (u0 on most devices). */
export async function getCurrentUser(deviceSerial: string): Promise<number> {
  const res = await runAdb(["-s", deviceSerial, "shell", "am", "get-current-user"], {
    timeoutMs: 5_000,
    allowNonZero: true,
  });
  const parsed = Number.parseInt(res.stdout.trim(), 10);
  // Fall back to u0 if the device is too old to support the command.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Parse `versionName` / `versionCode` out of `dumpsys package <pkg>`. */
export async function getPackageVersion(
  deviceSerial: string,
  packageName: string,
  userId: number,
): Promise<PackageVersion> {
  const res = await runAdb(
    ["-s", deviceSerial, "shell", "dumpsys", "package", ...userArgs(userId), packageName],
    { timeoutMs: 10_000, allowNonZero: true },
  );
  if (res.exitCode !== 0) return { versionName: null, versionCode: null };
  const versionName = /\bversionName=([^\s]+)/.exec(res.stdout)?.[1] ?? null;
  const versionCode = /\bversionCode=(\d+)/.exec(res.stdout)?.[1] ?? null;
  return { versionName, versionCode };
}

/**
 * Resolve the pids of `packageName`. `pidof` is the fast path; when it is
 * absent or returns nothing, fall back to scanning `ps -A`.
 */
export async function getAppPids(deviceSerial: string, packageName: string): Promise<number[]> {
  const pidof = await runAdb(["-s", deviceSerial, "shell", "pidof", packageName], {
    timeoutMs: 5_000,
    allowNonZero: true,
  });
  if (pidof.exitCode === 0) {
    const pids = parsePidList(pidof.stdout);
    if (pids.length > 0) return pids;
  }
  const ps = await runAdb(["-s", deviceSerial, "shell", "ps", "-A"], {
    timeoutMs: 8_000,
    allowNonZero: true,
  });
  if (ps.exitCode !== 0) return [];
  return parsePsForPackage(ps.stdout, packageName);
}

/** Find the resumed activity via `dumpsys activity activities`. */
export async function getForegroundActivity(
  deviceSerial: string,
  packageName: string,
): Promise<ForegroundActivity> {
  const res = await runAdb(["-s", deviceSerial, "shell", "dumpsys", "activity", "activities"], {
    timeoutMs: 10_000,
    allowNonZero: true,
  });
  if (res.exitCode !== 0) return { activity: null, foreground: false };
  const activity = parseResumedActivity(res.stdout);
  return {
    activity,
    foreground: activity?.startsWith(`${packageName}/`) === true,
  };
}

/** Parse `dumpsys activity exit-info <pkg>` (Android 11+). Empty on older OS. */
export async function getExitInfo(
  deviceSerial: string,
  packageName: string,
): Promise<ExitInfoEntry[]> {
  const res = await runAdb(
    ["-s", deviceSerial, "shell", "dumpsys", "activity", "exit-info", packageName],
    { timeoutMs: 8_000, allowNonZero: true },
  );
  if (res.exitCode !== 0) return [];
  return parseExitInfo(res.stdout);
}

/** Collect device props for `metadata.device`. */
export async function getDeviceProps(deviceSerial: string): Promise<DeviceProps> {
  const [model, sdk, abi, fingerprint] = await Promise.all([
    getProp(deviceSerial, "ro.product.model"),
    getProp(deviceSerial, "ro.build.version.sdk"),
    getProp(deviceSerial, "ro.product.cpu.abi"),
    getProp(deviceSerial, "ro.build.fingerprint"),
  ]);
  const apiLevel = sdk === null ? null : Number.parseInt(sdk, 10);
  return {
    model,
    apiLevel: apiLevel !== null && Number.isFinite(apiLevel) ? apiLevel : null,
    abi,
    buildFingerprint: fingerprint,
  };
}

/**
 * Launch `packageName`'s default LAUNCHER activity for `userId`. Resolves the
 * activity via `cmd package resolve-activity` then `am start -n`; if resolution
 * fails, falls back to `monkey` (current-user only). Returns the launched pid
 * when it can be observed shortly after, else null — the caller decides
 * whether a null pid is fatal (Phase 3 decision: it is not).
 */
export async function launchApp(
  deviceSerial: string,
  packageName: string,
  userId: number,
): Promise<{ launched: boolean; detail: string }> {
  const activity = await resolveLauncherActivity(deviceSerial, packageName, userId);
  if (activity !== null) {
    const res = await runAdb(
      ["-s", deviceSerial, "shell", "am", "start", ...userArgs(userId), "-n", activity],
      { timeoutMs: 10_000, allowNonZero: true },
    );
    if (res.exitCode === 0 && !/^Error:/m.test(res.stdout)) {
      return { launched: true, detail: `am start -n ${activity}` };
    }
    return {
      launched: false,
      detail: `am start failed: ${firstLine(res.stdout) || firstLine(res.stderr) || `exit ${res.exitCode}`}`,
    };
  }
  // Fallback: monkey launch (current-user only).
  const monkey = await runAdb(
    [
      "-s",
      deviceSerial,
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ],
    { timeoutMs: 10_000, allowNonZero: true },
  );
  if (monkey.exitCode === 0 && /Events injected: 1/.test(monkey.stdout)) {
    return { launched: true, detail: "monkey LAUNCHER fallback" };
  }
  return {
    launched: false,
    detail: `launch failed: no launcher activity resolved and monkey fallback failed (${firstLine(monkey.stdout) || `exit ${monkey.exitCode}`})`,
  };
}

/** `am force-stop --user <id> <pkg>`. */
export async function forceStopApp(
  deviceSerial: string,
  packageName: string,
  userId: number,
): Promise<void> {
  await runAdb(
    ["-s", deviceSerial, "shell", "am", "force-stop", ...userArgs(userId), packageName],
    { timeoutMs: 8_000 },
  );
}

/** `pm clear --user <id> <pkg>`. Throws via runAdb if pm reports failure. */
export async function clearAppData(
  deviceSerial: string,
  packageName: string,
  userId: number,
): Promise<{ ok: boolean; detail: string }> {
  const res = await runAdb(
    ["-s", deviceSerial, "shell", "pm", "clear", ...userArgs(userId), packageName],
    { timeoutMs: 12_000, allowNonZero: true },
  );
  const ok = res.exitCode === 0 && /(^|\s)Success\b/.test(res.stdout);
  return {
    ok,
    detail: ok
      ? "pm clear Success"
      : `pm clear failed: ${firstLine(res.stdout) || firstLine(res.stderr) || `exit ${res.exitCode}`}`,
  };
}

async function resolveLauncherActivity(
  deviceSerial: string,
  packageName: string,
  userId: number,
): Promise<string | null> {
  const res = await runAdb(
    [
      "-s",
      deviceSerial,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      ...userArgs(userId),
      packageName,
    ],
    { timeoutMs: 8_000, allowNonZero: true },
  );
  if (res.exitCode !== 0) return null;
  // Output's last non-empty line is `pkg/activity` on success.
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const last = lines.at(-1);
  if (last?.startsWith(`${packageName}/`)) return last;
  return null;
}

async function getProp(deviceSerial: string, prop: string): Promise<string | null> {
  const res = await runAdb(["-s", deviceSerial, "shell", "getprop", prop], {
    timeoutMs: 5_000,
    allowNonZero: true,
  });
  if (res.exitCode !== 0) return null;
  const value = res.stdout.trim();
  return value === "" ? null : value;
}

// ---- pure parsers (exported for unit tests) -------------------------------

export function parsePidList(stdout: string): number[] {
  return stdout
    .trim()
    .split(/\s+/)
    .map((t) => Number.parseInt(t, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function parsePsForPackage(stdout: string, packageName: string): number[] {
  const out: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // ps -A columns: USER PID PPID ... NAME (NAME is the last field).
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const name = cols.at(-1);
    if (name !== packageName) continue;
    const pid = Number.parseInt(cols[1] as string, 10);
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
}

export function parseResumedActivity(stdout: string): string | null {
  // Across API levels the marker is one of:
  //   topResumedActivity=ActivityRecord{hash u0 com.foo/.Main t12}
  //   mResumedActivity: ActivityRecord{hash u0 com.foo/.Main t12}
  //   ResumedActivity: ActivityRecord{... com.foo/.Main ...}
  const re =
    /(?:topResumedActivity|mResumedActivity|ResumedActivity)[=:]\s*ActivityRecord\{[^}]*?\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/;
  return re.exec(stdout)?.[1] ?? null;
}

export function parseExitInfo(stdout: string): ExitInfoEntry[] {
  const blocks = stdout.split(/ApplicationExitInfo\s+#\d+:?/).slice(1);
  const out: ExitInfoEntry[] = [];
  for (const block of blocks) {
    const timestamp = /\btimestamp=([^\n]+)/.exec(block)?.[1]?.trim() ?? null;
    const pidStr = /\bpid=(\d+)/.exec(block)?.[1];
    const pid = pidStr ? Number.parseInt(pidStr, 10) : null;
    const reason = /\breason=([^\n]+)/.exec(block)?.[1]?.trim() ?? null;
    const description = /\bdescription=([^\n]+)/.exec(block)?.[1]?.trim() ?? null;
    out.push({
      timestamp,
      pid: pid !== null && Number.isFinite(pid) ? pid : null,
      reason,
      description,
    });
  }
  return out;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}
