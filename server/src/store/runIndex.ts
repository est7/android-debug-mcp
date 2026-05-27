import { mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { IdentityError, assertSafeRunId } from "./identity.ts";
import { readMetadata } from "./metadata.ts";

const INDEX_REL = ".android-debug-mcp/run-index";
const ENV_VAR = "ANDROID_DEBUG_MCP_INDEX_ROOT";

/**
 * Per-host runId → runDir symlink index. Exists because `resolveRunRoot()`
 * may resolve to a different runRoot at lookup time than at run-creation
 * time (start_session called with explicit projectRoot=A, later tool call
 * runs from a cwd whose git toplevel is B), so the legacy "scan the current
 * runRoot" path misses stopped runs (§ 1.1-D in backlog).
 *
 * Single source of truth, O(1) lookup, dangling = naturally invalid.
 * Lives next to {@link getLocksRoot} under `~/.android-debug-mcp/` —
 * per-host, per-user, *not* per-repo, so it survives cwd / runRoot changes.
 *
 * Override path with `ANDROID_DEBUG_MCP_INDEX_ROOT` env var (parallel to
 * `ANDROID_DEBUG_MCP_RUN_ROOT`): useful for users who park state on a
 * different volume, and used by the test harness to keep runs hermetic.
 */
export function getRunIndexRoot(): string {
  const envValue = process.env[ENV_VAR];
  if (envValue && envValue.trim() !== "") {
    return isAbsolute(envValue) ? envValue : resolve(envValue);
  }
  return join(homedir(), INDEX_REL);
}

/**
 * Best-effort: write `<indexRoot>/<runId>` as a symlink to `runDir`.
 *
 * Symlink creation can fail (e.g. filesystem doesn't support symlinks, EACCES,
 * EEXIST race). Callers MUST treat failure as non-fatal — the index is a
 * convenience cache, not a contract. The run dir + metadata.json on disk
 * remain authoritative; cross-runRoot lookup is the only thing degraded.
 *
 * The path is overwritten if it already exists (idempotent re-write, e.g.
 * when a recovery flow re-registers an existing run).
 */
export async function writeRunIndex(runId: string, runDir: string): Promise<void> {
  assertSafeRunId(runId);
  const root = getRunIndexRoot();
  await mkdir(root, { recursive: true });
  const target = isAbsolute(runDir) ? runDir : resolve(runDir);
  const linkPath = join(root, runId);
  try {
    await symlink(target, linkPath);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "EEXIST") throw err;
    // Idempotent re-write: clear and retry once. A race with another writer
    // is acceptable — both writers are pointing at the same logical run.
    await unlink(linkPath);
    await symlink(target, linkPath);
  }
}

/**
 * Return the absolute runDir for `runId` if the index has a valid entry, else
 * null. "Valid" = symlink exists AND the target dir's `metadata.json` parses
 * AND `metadata.runId === runId`. The runId equality check defends against
 * cross-runId pollution: a mis-created (manual symlink, recovery race, future
 * bug) entry `<index>/<runIdA> -> runDir-of-runIdB` must NOT serve B's runDir
 * for a lookup of A — `resolveRunDir`'s contract is that the returned dir is
 * the dir of the requested runId, not "any run dir we could find."
 *
 * A runId that fails {@link assertSafeRunId} (malformed format, traversal
 * characters) returns null — `resolveRunDir`'s contract is "any string the
 * agent supplies maps to run_missing if unknown", and the legacy scan path
 * tolerates arbitrary strings, so the index must too. Path safety is still
 * preserved: the validator's traversal check rejects any string that could
 * escape the index root, and {@link writeRunIndex} retains its strict assert.
 */
export async function readRunIndex(runId: string): Promise<string | null> {
  try {
    assertSafeRunId(runId);
  } catch (err) {
    if (err instanceof IdentityError) return null;
    throw err;
  }
  const linkPath = join(getRunIndexRoot(), runId);
  let target: string;
  try {
    target = await readlink(linkPath);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EINVAL" || code === "ENOTDIR") return null;
    throw err;
  }
  const absolute = isAbsolute(target) ? target : resolve(getRunIndexRoot(), target);
  try {
    const metadata = await readMetadata(absolute);
    if (metadata.runId !== runId) return null;
  } catch {
    // Dangling target, unreadable / invalid / missing metadata.json — treat as
    // "no valid index entry" and fall through to scan. readMetadata throws on
    // ENOENT, ENOTDIR, JSON parse error, and schema validation failure; the
    // caller's contract is the same for all of them.
    return null;
  }
  return absolute;
}

/**
 * Remove a run from the index. Safe to call when the entry does not exist
 * (ENOENT is swallowed). Not called by the runtime today — provided for a
 * future `cleanup_index` flow or test cleanup.
 */
export async function removeRunIndex(runId: string): Promise<void> {
  assertSafeRunId(runId);
  try {
    await unlink(join(getRunIndexRoot(), runId));
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
  }
}
