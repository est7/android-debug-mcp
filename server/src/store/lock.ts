import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSafeDeviceSerial,
  assertSafePackageName,
  assertSafeRunId,
  assertSafeUserId,
} from "./identity.ts";
import { getLocksRoot } from "./paths.ts";

export type LockErrorCode =
  | "lock_held_by_active_owner"
  | "lock_owner_unreadable"
  | "lock_release_failed";

export class LockError extends Error {
  readonly code: LockErrorCode;
  readonly lockPath: string;
  readonly owner?: LockOwner;
  constructor(code: LockErrorCode, lockPath: string, message: string, owner?: LockOwner) {
    super(message);
    this.name = "LockError";
    this.code = code;
    this.lockPath = lockPath;
    if (owner !== undefined) this.owner = owner;
  }
}

/** Persisted payload inside the lockfile. JSON-encoded as one line. */
export interface LockOwner {
  readonly pid: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly deviceSerial: string;
  readonly userId: number;
  readonly packageName: string;
  /** Optional process start time in ms-since-epoch. Used for PID-recycle defense. */
  readonly processStartMs?: number;
}

export interface AcquireLockInput {
  readonly deviceSerial: string;
  readonly userId: number;
  readonly packageName: string;
  readonly runId: string;
  readonly startedAt: Date;
  /**
   * When true, evict an existing stale lock without checking pid liveness.
   * Intended for orphan-recovery scenarios in Phase 8, not normal start_session.
   */
  readonly force?: boolean;
}

export interface LockHandle {
  readonly path: string;
  readonly owner: LockOwner;
  release(): Promise<void>;
}

/**
 * Injection points exposed for tests. Production code uses the defaults below.
 *   - `isPidAlive`: `process.kill(pid, 0)` returns true iff the pid is alive.
 *   - `getProcessStartMs`: pid → ms-since-epoch start time, or null if unknown.
 */
export interface LockDeps {
  readonly isPidAlive: (pid: number) => boolean;
  readonly getProcessStartMs: (pid: number) => number | null;
}

const defaultDeps: LockDeps = {
  isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // EPERM means the pid exists but we don't own it — still alive.
      return code === "EPERM";
    }
  },
  getProcessStartMs(): number | null {
    // No portable cross-platform pid → start_time without parsing /proc or
    // shelling out to `ps -o lstart`. Returning null falls back to lock-file
    // start time alone for stale detection; cheap and correct for v1.
    return null;
  },
};

export function lockPathFor(deviceSerial: string, userId: number, packageName: string): string {
  // Validate before path concatenation: prevents `../evil` segments from
  // escaping `getLocksRoot()` or colliding with another (device, user, pkg).
  assertSafeDeviceSerial(deviceSerial);
  assertSafeUserId(userId);
  assertSafePackageName(packageName);
  return join(getLocksRoot(), `${deviceSerial}.${userId}.${packageName}.lock`);
}

/**
 * Acquire the global (deviceSerial, userId, packageName) lock. Behavior:
 *
 *   1. Open the lockfile with O_EXCL. Success → write owner JSON, return handle.
 *   2. On EEXIST, read the existing owner:
 *      - If `force: true`, evict and re-acquire (Phase 8 recovery path).
 *      - If owner unreadable / corrupt → throw `lock_owner_unreadable`.
 *      - If `isPidAlive(owner.pid)` is true AND we cannot prove pid recycling
 *        (no start-time data, or start-time matches) → throw
 *        `lock_held_by_active_owner` with the existing owner attached.
 *      - Otherwise treat as stale, evict and re-acquire.
 */
export async function acquireLock(
  input: AcquireLockInput,
  deps: LockDeps = defaultDeps,
): Promise<LockHandle> {
  // Defense-in-depth: lockPathFor also validates, but we assert runId here so
  // owner-guard release (which compares runId) is safe to build later.
  assertSafeRunId(input.runId);
  const path = lockPathFor(input.deviceSerial, input.userId, input.packageName);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      const owner: LockOwner = {
        pid: process.pid,
        runId: input.runId,
        startedAt: input.startedAt.toISOString(),
        deviceSerial: input.deviceSerial,
        userId: input.userId,
        packageName: input.packageName,
        ...maybeProcessStart(deps),
      };
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return makeHandle(path, owner);
    } catch (err) {
      if ((err as { code?: unknown }).code !== "EEXIST") throw err;
      const existing = await readOwnerOrThrow(path);
      if (input.force) {
        await unlink(path);
        continue;
      }
      if (isOwnerLive(existing, deps)) {
        throw new LockError(
          "lock_held_by_active_owner",
          path,
          `Lock held by pid ${existing.pid} (run ${existing.runId}, started ${existing.startedAt}).`,
          existing,
        );
      }
      // Stale: evict and retry once.
      // TOCTOU note: a third process could replace the lockfile between the
      // readOwnerOrThrow() above and this unlink(); the evictor may then
      // unlink the *replacement*. Owner-guard release (see {@link makeHandle})
      // is the primary defense — even if we delete someone else's lock here,
      // their release() call will be a no-op when it sees a different owner
      // or a missing file. Inode-guard via fstat is deferred to v2 / Phase 8
      // recovery, where the stale-eviction window matters more.
      await unlink(path);
    }
  }
  // Unreachable: each EEXIST either throws or unlinks + continues, and the
  // first open path returns directly.
  throw new LockError(
    "lock_held_by_active_owner",
    path,
    "Lock acquisition retry exhausted unexpectedly.",
  );
}

/**
 * Whether a lock owner's process is still alive — the § C-5 liveness check,
 * reusing `acquireLock`'s exact semantics (pid alive, plus `processStartMs`
 * match when both sides have start-time evidence; absence of evidence is
 * treated as live). Orphan recovery uses this so it cannot diverge from
 * `acquireLock`'s notion of "stale".
 */
export function isLockOwnerLive(owner: LockOwner, deps: LockDeps = defaultDeps): boolean {
  return isOwnerLive(owner, deps);
}

/**
 * Owner-guarded removal of a stale lockfile, for orphan recovery (§ C-5).
 * Unlinks `path` ONLY when its current on-disk owner still matches `expected`
 * — so a stale lock that another process has since evicted and reacquired is
 * left untouched. Same TOCTOU defense as a live handle's `release()`: a blind
 * `unlink` during recovery could otherwise delete a live successor's lock.
 */
export async function releaseLockIfOwner(path: string, expected: LockOwner): Promise<void> {
  const current = await readLockOwner(path);
  if (current === null) return; // already gone
  if (!isSameOwner(current, expected)) return; // a different owner holds it now
  try {
    await unlink(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return;
    throw new LockError(
      "lock_release_failed",
      path,
      `Failed to release stale lock: ${(err as Error).message ?? String(err)}`,
    );
  }
}

/** Read the owner of an existing lockfile, returning null if the file is missing. */
export async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text.trim());
    return validateOwner(parsed);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

function maybeProcessStart(deps: LockDeps): { processStartMs?: number } {
  const ms = deps.getProcessStartMs(process.pid);
  return ms === null ? {} : { processStartMs: ms };
}

function makeHandle(path: string, owner: LockOwner): LockHandle {
  let released = false;
  return {
    path,
    owner,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Owner-guard: only unlink when the current on-disk owner still matches
      // this handle's owner. Without this, a stale handle (e.g. left over
      // after a force eviction or stale-detection race) would delete a
      // perfectly live successor's lock. Mismatch = silent no-op.
      let current: LockOwner | null;
      try {
        current = await readLockOwner(path);
      } catch (err) {
        // Corrupt lock file: someone wrote garbage there, but it isn't us.
        // Leaving it in place lets `acquireLock` surface the corruption to a
        // future caller instead of silently masking it here.
        throw new LockError(
          "lock_release_failed",
          path,
          `Failed to inspect lock owner before release: ${(err as Error).message ?? String(err)}`,
        );
      }
      if (current === null) return; // already gone
      if (!isSameOwner(current, owner)) return; // someone else owns this slot now
      try {
        await unlink(path);
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") return;
        throw new LockError(
          "lock_release_failed",
          path,
          `Failed to release lock: ${(err as Error).message ?? String(err)}`,
        );
      }
    },
  };
}

function isSameOwner(a: LockOwner, b: LockOwner): boolean {
  return (
    a.pid === b.pid &&
    a.runId === b.runId &&
    a.startedAt === b.startedAt &&
    a.deviceSerial === b.deviceSerial &&
    a.userId === b.userId &&
    a.packageName === b.packageName
  );
}

async function readOwnerOrThrow(path: string): Promise<LockOwner> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new LockError(
      "lock_owner_unreadable",
      path,
      `Lock file exists but cannot be read: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new LockError("lock_owner_unreadable", path, "Lock file is not valid JSON.");
  }
  const owner = validateOwner(parsed);
  if (!owner) {
    throw new LockError(
      "lock_owner_unreadable",
      path,
      "Lock file JSON is missing required fields (pid / runId / startedAt).",
    );
  }
  return owner;
}

function validateOwner(value: unknown): LockOwner | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.pid !== "number") return null;
  if (typeof v.runId !== "string") return null;
  if (typeof v.startedAt !== "string") return null;
  if (typeof v.deviceSerial !== "string") return null;
  if (typeof v.userId !== "number") return null;
  if (typeof v.packageName !== "string") return null;
  const owner: LockOwner = {
    pid: v.pid,
    runId: v.runId,
    startedAt: v.startedAt,
    deviceSerial: v.deviceSerial,
    userId: v.userId,
    packageName: v.packageName,
    ...(typeof v.processStartMs === "number" ? { processStartMs: v.processStartMs } : {}),
  };
  return owner;
}

function isOwnerLive(owner: LockOwner, deps: LockDeps): boolean {
  if (!deps.isPidAlive(owner.pid)) return false;
  if (owner.processStartMs === undefined) return true; // no start-time evidence → treat as live
  const currentStart = deps.getProcessStartMs(owner.pid);
  if (currentStart === null) return true; // cannot disprove
  return currentStart === owner.processStartMs;
}
