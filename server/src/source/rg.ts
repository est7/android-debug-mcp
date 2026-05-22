import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { RgNotFoundError, SearchTimedOutError } from "./errors.ts";

const execFileAsync = promisify(execFile);

/**
 * Hard ceiling for a single `rg --json` capture. A search that produces more
 * than this is itself a signal something is wrong (a pattern far too broad);
 * the cap turns it into a clean failure instead of an unbounded buffer.
 */
const RG_MAX_BUFFER = 16 * 1024 * 1024;

/** Default per-invocation time budget. The recipe runs a few `rg` calls; each gets this. */
export const RG_DEFAULT_TIMEOUT_MS = 10_000;

let cachedRgPath: string | null = null;

/**
 * Resolve the `rg` (ripgrep) binary, `RG_PATH` env var winning over PATH
 * lookup. Memoized for the process lifetime; call {@link resetRgPathCache}
 * from tests. Modeled on `adb/adb.ts::getAdbPath` — `rg` is an external CLI
 * resolved at a chokepoint, never an npm dependency.
 */
export async function getRgPath(): Promise<string> {
  if (cachedRgPath !== null) return cachedRgPath;
  const envOverride = process.env.RG_PATH;
  const searched: string[] = [];
  if (envOverride && envOverride.trim() !== "") {
    searched.push(`RG_PATH=${envOverride}`);
    // Validate up-front so a typo'd RG_PATH fails here, not as a raw spawn
    // ENOENT from the first runRg call.
    if (!isExecutable(envOverride)) {
      throw new RgNotFoundError(searched);
    }
    cachedRgPath = envOverride;
    return cachedRgPath;
  }
  searched.push("$(which rg)");
  const which = spawnSync("which", ["rg"], { encoding: "utf8" });
  if (which.status === 0) {
    const path = (which.stdout ?? "").trim();
    if (path !== "" && isExecutable(path)) {
      cachedRgPath = path;
      return cachedRgPath;
    }
  }
  throw new RgNotFoundError(searched);
}

export function resetRgPathCache(): void {
  cachedRgPath = null;
}

export interface RunRgOptions {
  /** Directory `rg` searches and reports paths relative to. Required. */
  readonly cwd: string;
  /** ms ceiling; on timeout the child is killed and {@link SearchTimedOutError} is thrown. */
  readonly timeoutMs?: number;
}

export interface RgRunResult {
  /** Raw stdout. `exitCode` 1 (no matches) still yields a parseable (match-free) stream. */
  readonly stdout: string;
  /** 0 = matches found, 1 = no matches. Exit 2 (a genuine `rg` error) throws instead. */
  readonly exitCode: 0 | 1;
}

/**
 * Run `rg <args>` to completion. ripgrep's exit codes are part of the
 * contract: 0 = matches, 1 = no matches (a normal, non-error outcome — chain M
 * branches on it as a soft `none`), 2 = a real failure.
 *
 * Callers MUST include an explicit search path (`.`) in `args`: with no path
 * `rg` reads stdin, which under a child-process pipe never closes.
 *
 * Throws {@link RgNotFoundError} when the binary is unrunnable,
 * {@link SearchTimedOutError} on timeout, and a plain `Error` on exit 2 (a bug
 * in the caller's pattern/args — it propagates as a protocol error).
 */
export async function runRg(args: readonly string[], opts: RunRgOptions): Promise<RgRunResult> {
  const rgPath = await getRgPath();
  const timeoutMs = opts.timeoutMs ?? RG_DEFAULT_TIMEOUT_MS;
  try {
    const { stdout } = await execFileAsync(rgPath, [...args], {
      cwd: opts.cwd,
      encoding: "utf8",
      maxBuffer: RG_MAX_BUFFER,
      timeout: timeoutMs,
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    return handleRunRgError(rgPath, err, timeoutMs);
  }
}

function handleRunRgError(rgPath: string, err: unknown, timeoutMs: number): RgRunResult {
  if (isENOENT(err)) {
    throw new RgNotFoundError([rgPath]);
  }
  const e = err as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown };
  // `killed` is set when execFile's `timeout` fired and SIGTERM'd the child.
  if (e.killed === true) {
    throw new SearchTimedOutError(timeoutMs);
  }
  // Exit 1 = no matches. ripgrep still wrote a (match-free) JSON summary stream.
  if (e.code === 1) {
    return { stdout: typeof e.stdout === "string" ? e.stdout : "", exitCode: 1 };
  }
  // Exit 2 / anything else: a genuine rg failure (bad regex, bad args). The
  // recipe builds every pattern itself, so this is a bug — fail loud.
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  throw new Error(`rg exited ${String(e.code)}: ${stderr.trim() || "<no output>"}`);
}

export interface RgMatch {
  /** Path as `rg` reported it, relative to the search cwd, no leading `./`. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The matched line, trailing newline stripped. */
  readonly text: string;
}

/**
 * Parse the newline-delimited JSON stream from `rg --json` into match records.
 * Only `type:"match"` objects are kept; `begin` / `end` / `summary` framing
 * lines are skipped, as are matches whose path is non-UTF-8 (`rg` reports
 * those with a `bytes` key and no usable relative path).
 */
export function parseRgJsonMatches(stdout: string): RgMatch[] {
  const out: RgMatch[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // `rg --json` emits only well-formed JSON lines; a stray non-JSON line
      // is skipped rather than aborting the whole search.
      continue;
    }
    const match = readMatch(parsed);
    if (match !== null) out.push(match);
  }
  return out;
}

function readMatch(parsed: unknown): RgMatch | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { type?: unknown; data?: unknown };
  if (obj.type !== "match" || typeof obj.data !== "object" || obj.data === null) return null;
  const data = obj.data as {
    path?: { text?: unknown };
    line_number?: unknown;
    lines?: { text?: unknown };
  };
  const file = data.path?.text;
  const lineNumber = data.line_number;
  const text = data.lines?.text;
  if (typeof file !== "string" || typeof lineNumber !== "number") return null;
  return {
    file: file.replace(/^\.\//, ""),
    line: lineNumber,
    text: typeof text === "string" ? text.replace(/\r?\n$/, "") : "",
  };
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
