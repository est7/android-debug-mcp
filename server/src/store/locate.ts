import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ToolDomainError } from "../mcp/toolError.ts";
import type { SessionManager } from "../session/manager.ts";
import { METADATA_FILENAME, type Metadata, readMetadata } from "./metadata.ts";
import { resolveRunRoot } from "./paths.ts";
import { readRunIndex } from "./runIndex.ts";

export interface RunEntry {
  readonly runDir: string;
  readonly metadata: Metadata;
}

/**
 * Resolve a runId to its on-disk run directory.
 *
 * The Phase 7 evidence tools (`search_logs` / `extract_crash_context` /
 * `get_run_summary`) take a runId for a run that may still be active OR long
 * finalized. A runId is a timestamp + random suffix ({@link mintRunId}) and
 * carries no package / userId, so a finalized run can only be found by walking
 * `<runRoot>/<package>/u<userId>/<runId>/`.
 *
 * Resolution order:
 *   1. Active sessions — cheap, authoritative for their runDir regardless of
 *      which runRoot the session was created under.
 *   2. Host-global run-index (`~/.android-debug-mcp/run-index/<runId>`) —
 *      O(1) symlink lookup that survives cwd / runRoot changes (§ 1.1-D).
 *      Registered best-effort at {@link createRunDir} time; dangling /
 *      stale entries fall through silently.
 *   3. Scan the *current* {@link resolveRunRoot} tree — backward-compat for
 *      runs created before the index existed, and a safety net if the
 *      symlink write failed.
 */
export async function resolveRunDir(manager: SessionManager, runId: string): Promise<string> {
  for (const session of manager.listActive()) {
    if (session.runId === runId) return session.runDir;
  }
  const indexed = await readRunIndex(runId);
  if (indexed !== null) return indexed;
  const { runRoot } = resolveRunRoot();
  const found = await scanForRun(runRoot, runId);
  if (found !== null) return found;
  throw new ToolDomainError("run_missing", `No run found for runId ${runId}.`, { runId });
}

/** Walk `<runRoot>/<package>/u<userId>/` looking for a `<runId>/` with metadata. */
async function scanForRun(runRoot: string, runId: string): Promise<string | null> {
  for (const pkg of await safeReaddir(runRoot)) {
    const pkgDir = join(runRoot, pkg);
    for (const userDir of await safeReaddir(pkgDir)) {
      const candidate = join(pkgDir, userDir, runId);
      if (await hasMetadata(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Enumerate every run under `runRoot` — walk `<runRoot>/<package>/u<userId>/`
 * and read each `<runId>/metadata.json`. A path without a readable, valid
 * metadata.json is skipped (a stray file, a half-created folder, a `bundles/`
 * dir). Shared by orphan recovery and `list_runs`.
 */
export async function enumerateRuns(runRoot: string): Promise<RunEntry[]> {
  const out: RunEntry[] = [];
  for (const pkg of await safeReaddir(runRoot)) {
    const pkgDir = join(runRoot, pkg);
    for (const userDir of await safeReaddir(pkgDir)) {
      const userPath = join(pkgDir, userDir);
      for (const runId of await safeReaddir(userPath)) {
        const runDir = join(userPath, runId);
        try {
          out.push({ runDir, metadata: await readMetadata(runDir) });
        } catch {
          // No / unreadable / invalid metadata.json → not a well-formed run.
        }
      }
    }
  }
  return out;
}

async function hasMetadata(runDir: string): Promise<boolean> {
  try {
    return (await stat(join(runDir, METADATA_FILENAME))).isFile();
  } catch {
    return false;
  }
}

/**
 * `readdir` that tolerates a missing dir (ENOENT) and a non-directory path
 * (ENOTDIR) — a tree walker must not crash on a stray file (e.g. a bundle
 * archive) sitting where it expects a directory.
 */
async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}
