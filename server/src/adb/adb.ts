import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { AdbExecError, AdbNotFoundError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/**
 * Hard ceiling for a single `runAdb` capture. `dumpsys` output can be large
 * (hundreds of KB), but a multi-MB capture from a short command means
 * something is wrong — the cap turns that into a clean error instead of an
 * unbounded buffer. Streaming commands (logcat) must use {@link spawnAdb}.
 */
const RUN_ADB_MAX_BUFFER = 16 * 1024 * 1024;

/** Synthetic exit code reported when a `runAdb` call is killed by `timeoutMs`. */
export const ADB_TIMEOUT_EXIT_CODE = 124;

export interface RunAdbOptions {
  /** Per-call working directory. Defaults to the spawning process cwd. */
  readonly cwd?: string;
  /**
   * Optional ms ceiling. On timeout the child is killed; the returned
   * `exitCode` is {@link ADB_TIMEOUT_EXIT_CODE} (124) so the caller can tell a
   * timeout apart from a normal non-zero exit.
   */
  readonly timeoutMs?: number;
  /** When true, do not throw on non-zero exit; the caller inspects the returned record. */
  readonly allowNonZero?: boolean;
}

export interface AdbResult {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

let cachedAdbPath: string | null = null;

/**
 * Resolve the adb binary, with `ADB_PATH` env var winning over PATH lookup.
 * Memoized for the process lifetime; call {@link resetAdbPathCache} from tests.
 *
 * Uses `node:child_process` (not `Bun.spawn`) so the adb layer behaves
 * identically under `bun run` and under vitest's Node runtime.
 */
export async function getAdbPath(): Promise<string> {
  if (cachedAdbPath !== null) return cachedAdbPath;
  const envOverride = process.env.ADB_PATH;
  const searched: string[] = [];
  if (envOverride && envOverride.trim() !== "") {
    searched.push(`ADB_PATH=${envOverride}`);
    // Validate up-front: avoids leaking a raw spawn ENOENT from the first
    // runAdb / spawnAdb call when the user typo'd ADB_PATH.
    if (!isExecutable(envOverride)) {
      throw new AdbNotFoundError(searched);
    }
    cachedAdbPath = envOverride;
    return cachedAdbPath;
  }
  searched.push("$(which adb)");
  const which = spawnSync("which", ["adb"], { encoding: "utf8" });
  if (which.status === 0) {
    const path = (which.stdout ?? "").trim();
    if (path !== "" && isExecutable(path)) {
      cachedAdbPath = path;
      return cachedAdbPath;
    }
  }
  throw new AdbNotFoundError(searched);
}

export function resetAdbPathCache(): void {
  cachedAdbPath = null;
}

/**
 * Run `adb <args>` to completion and capture stdout/stderr as utf-8 strings.
 * Throws {@link AdbExecError} on non-zero exit unless `allowNonZero` is set,
 * and {@link AdbNotFoundError} when the binary cannot be executed.
 * Long-running streaming work (logcat) must use {@link spawnAdb}.
 */
export async function runAdb(
  args: readonly string[],
  opts: RunAdbOptions = {},
): Promise<AdbResult> {
  const adbPath = await getAdbPath();
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, [...args], {
      encoding: "utf8",
      maxBuffer: RUN_ADB_MAX_BUFFER,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return { args, stdout, stderr, exitCode: 0 };
  } catch (err) {
    return handleRunAdbError(args, adbPath, err, opts);
  }
}

function handleRunAdbError(
  args: readonly string[],
  adbPath: string,
  err: unknown,
  opts: RunAdbOptions,
): AdbResult {
  if (isENOENT(err)) {
    throw new AdbNotFoundError([adbPath]);
  }
  const e = err as {
    code?: unknown;
    signal?: unknown;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
  };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  // Non-zero exit: execFile sets `code` to the numeric exit status.
  const exitCode =
    typeof e.code === "number"
      ? e.code
      : e.killed === true
        ? ADB_TIMEOUT_EXIT_CODE // killed by `timeout` option
        : -1; // maxBuffer overflow / other failure
  if (opts.allowNonZero) {
    return { args, stdout, stderr, exitCode };
  }
  throw new AdbExecError(args, exitCode, stdout, stderr);
}

/**
 * Spawn `adb <args>` as a long-running child (e.g. `adb logcat`). The returned
 * `ChildProcess` exposes `.stdout` / `.stderr` Node Readable streams; the
 * caller owns its lifecycle (kill / await `exit` / drain / listen for `error`).
 *
 * Note: `getAdbPath()` has already verified the binary is executable, so a
 * spawn ENOENT is not expected — but the caller should still attach an
 * `'error'` listener, since spawn reports ENOENT asynchronously.
 */
export async function spawnAdb(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<ChildProcess> {
  const adbPath = await getAdbPath();
  return spawn(adbPath, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isENOENT(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "ENOENT") return true;
  return typeof e.message === "string" && /ENOENT/.test(e.message);
}
