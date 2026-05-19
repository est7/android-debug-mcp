import { accessSync, constants as fsConstants } from "node:fs";
import { AdbExecError, AdbNotFoundError } from "./errors.ts";

export interface RunAdbOptions {
  /** Per-call working directory. Defaults to the spawning process cwd. */
  readonly cwd?: string;
  /**
   * Optional ms ceiling. On timeout the child is killed via SIGTERM, so the
   * returned `exitCode` is typically 143 (or platform-specific). The caller can
   * inspect `exitCode` to distinguish kill from a normal non-zero exit.
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
 * The result is memoized for the lifetime of this process to avoid repeated `which` spawns;
 * call {@link resetAdbPathCache} from tests if you need to re-resolve.
 */
export async function getAdbPath(): Promise<string> {
  if (cachedAdbPath !== null) return cachedAdbPath;
  const envOverride = process.env.ADB_PATH;
  const searched: string[] = [];
  if (envOverride && envOverride.trim() !== "") {
    searched.push(`ADB_PATH=${envOverride}`);
    // Validate up-front: avoids leaking a raw posix_spawn ENOENT from the
    // first runAdb / spawnAdb call when the user typo'd ADB_PATH.
    if (!isExecutable(envOverride)) {
      throw new AdbNotFoundError(searched);
    }
    cachedAdbPath = envOverride;
    return cachedAdbPath;
  }
  searched.push("$(which adb)");
  const which = Bun.spawnSync({ cmd: ["which", "adb"], stdout: "pipe", stderr: "pipe" });
  if (which.exitCode === 0) {
    const path = which.stdout.toString().trim();
    if (path !== "" && isExecutable(path)) {
      cachedAdbPath = path;
      return cachedAdbPath;
    }
  }
  throw new AdbNotFoundError(searched);
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

export function resetAdbPathCache(): void {
  cachedAdbPath = null;
}

/**
 * Run `adb <args>` to completion and capture stdout/stderr as utf-8 strings.
 * Throws {@link AdbExecError} on non-zero exit unless `allowNonZero` is set.
 * Long-running streaming work (logcat) should use {@link spawnAdb} instead.
 */
export async function runAdb(
  args: readonly string[],
  opts: RunAdbOptions = {},
): Promise<AdbResult> {
  const adbPath = await getAdbPath();
  const child = spawnAdbProcess(adbPath, args, opts.cwd);
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore: child may have already exited
          }
        }, opts.timeoutMs)
      : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const result: AdbResult = { args, stdout, stderr, exitCode };
  if (exitCode !== 0 && !opts.allowNonZero) {
    throw new AdbExecError(args, exitCode, stdout, stderr);
  }
  return result;
}

/**
 * Spawn `adb <args>` as a long-running child (e.g. `adb logcat`).
 * Returned subprocess exposes stdout / stderr ReadableStreams and `.exited`.
 * Caller owns lifecycle (kill / await exit / drain streams).
 */
export async function spawnAdb(
  args: readonly string[],
  opts: { cwd?: string } = {},
): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
  const adbPath = await getAdbPath();
  try {
    return Bun.spawn({
      cmd: [adbPath, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
  } catch (err) {
    if (isENOENT(err)) {
      throw new AdbNotFoundError([adbPath]);
    }
    throw err;
  }
}

function spawnAdbProcess(adbPath: string, args: readonly string[], cwd: string | undefined) {
  try {
    return Bun.spawn({
      cmd: [adbPath, ...args],
      stdout: "pipe",
      stderr: "pipe",
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (err) {
    if (isENOENT(err)) {
      throw new AdbNotFoundError([adbPath]);
    }
    throw err;
  }
}
