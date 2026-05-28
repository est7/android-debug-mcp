import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type RunRootSource = "explicit" | "env" | "cwd-git" | "fallback";

export interface ResolveRunRootInput {
  /**
   * Explicit `projectRoot` passed via `start_session({ projectRoot })`. Wins over
   * env / cwd-git / fallback when present and non-empty (§ C-3 step 1).
   */
  readonly projectRoot?: string;
  /**
   * Working directory to probe for `git rev-parse --show-toplevel`. Defaults to
   * `process.cwd()`. Tests inject this to avoid environmental leakage.
   */
  readonly cwd?: string;
}

export interface ResolvedRunRoot {
  readonly runRoot: string;
  readonly source: RunRootSource;
}

const ENV_VAR = "ANDROID_DEBUG_MCP_RUN_ROOT";
const LOCKS_ENV_VAR = "ANDROID_DEBUG_MCP_LOCKS_ROOT";
const REPO_LOCAL_DIRNAME = ".android-debug-runs";
const HOME_FALLBACK_REL = ".android-debug-mcp/runs";

// Memoize the most recent resolution per call shape. Most servers call this
// once per process; we still key on inputs so tests can switch without
// resetting global state.
const cache = new Map<string, ResolvedRunRoot>();

/**
 * Resolve where this server should land its `runs/` tree. Four sources, first
 * non-empty wins (§ C-3 in decision-amendments.md):
 *
 *   1. `projectRoot` arg → `<projectRoot>/<REPO_LOCAL_DIRNAME>/`
 *   2. `ANDROID_DEBUG_MCP_RUN_ROOT` env var (taken verbatim — caller decides
 *      whether to append `runs/`)
 *   3. `git -C <cwd> rev-parse --show-toplevel` → `<top>/<REPO_LOCAL_DIRNAME>/`
 *   4. `~/.android-debug-mcp/runs/`
 */
export function resolveRunRoot(input: ResolveRunRootInput = {}): ResolvedRunRoot {
  const cwd = input.cwd ?? process.cwd();
  const cacheKey = JSON.stringify({ projectRoot: input.projectRoot ?? null, cwd });
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let resolved: ResolvedRunRoot;
  if (input.projectRoot && input.projectRoot.trim() !== "") {
    resolved = {
      runRoot: ensureAbsolute(join(input.projectRoot, REPO_LOCAL_DIRNAME)),
      source: "explicit",
    };
  } else {
    const envValue = process.env[ENV_VAR];
    if (envValue && envValue.trim() !== "") {
      resolved = { runRoot: ensureAbsolute(envValue), source: "env" };
    } else {
      const gitTop = gitTopLevel(cwd);
      if (gitTop) {
        resolved = {
          runRoot: ensureAbsolute(join(gitTop, REPO_LOCAL_DIRNAME)),
          source: "cwd-git",
        };
      } else {
        resolved = {
          runRoot: ensureAbsolute(join(homedir(), HOME_FALLBACK_REL)),
          source: "fallback",
        };
      }
    }
  }
  mkdirSync(resolved.runRoot, { recursive: true });
  cache.set(cacheKey, resolved);
  return resolved;
}

export interface ResolveProjectRootInput {
  /**
   * Explicit `projectRoot` from `start_session({ projectRoot })`. When present
   * and non-empty it is the directory probed for the git top-level — the app
   * under debug is rarely the MCP server's own cwd, so cwd alone is wrong.
   */
  readonly projectRoot?: string;
  /** Directory probed when no explicit `projectRoot` is given. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

// Memoized separately from `cache` (runRoot): different value shape, same
// resetPathsCache() lifecycle. Stores `null` for non-git probe dirs so a
// repeated miss does not re-spawn git.
const projectRootCache = new Map<string, string | null>();

/**
 * Resolve the source tree this run maps UI nodes back into (v2-A chain M, Q5).
 *
 * The probe directory is the explicit `projectRoot` when given, else `cwd`. It
 * is always normalized through `git rev-parse --show-toplevel`: a sub-dir
 * resolves to its repository root, a non-git directory resolves to `null`. The
 * source root is never inferred from `runRoot` and cwd is never used verbatim —
 * a `null` here surfaces downstream as `project_root_missing`, not a guess.
 *
 * Memoized per probe directory; {@link resetPathsCache} clears it.
 */
export function resolveProjectRoot(input: ResolveProjectRootInput = {}): string | null {
  const probeDir =
    input.projectRoot && input.projectRoot.trim() !== ""
      ? input.projectRoot
      : (input.cwd ?? process.cwd());
  const cached = projectRootCache.get(probeDir);
  if (cached !== undefined) return cached;
  const resolved = gitTopLevel(probeDir);
  projectRootCache.set(probeDir, resolved);
  return resolved;
}

/**
 * Lockfiles live globally (per user nod 2026-05-19, overriding plan #2 tentative
 * "repo-local"): a single (deviceSerial, userId, packageName) tuple must
 * serialize across all repositories and runRoot choices on this host.
 */
export function getLocksRoot(): string {
  const envValue = process.env[LOCKS_ENV_VAR];
  const path =
    envValue && envValue.trim() !== ""
      ? ensureAbsolute(envValue)
      : join(homedir(), ".android-debug-mcp", "locks");
  mkdirSync(path, { recursive: true });
  return path;
}

export function resetPathsCache(): void {
  cache.clear();
  projectRootCache.clear();
}

function ensureAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function gitTopLevel(cwd: string): string | null {
  // node:child_process used (not Bun.spawnSync) so this works under both
  // `bun run server.ts` and vitest's Node runtime — Bun re-exports the Node
  // module faithfully, so production behavior is unchanged.
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) return null;
    const top = (result.stdout ?? "").trim();
    return top === "" ? null : top;
  } catch {
    return null;
  }
}
