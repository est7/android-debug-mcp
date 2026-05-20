import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type ReplayResult, replayParse } from "../logcat/recovery.ts";
import { createLogger } from "../mcp/log.ts";
import { enumerateRuns } from "../store/locate.ts";
import {
  type LockOwner,
  isLockOwnerLive,
  lockPathFor,
  readLockOwner,
  releaseLockIfOwner,
} from "../store/lock.ts";
import { type Metadata, patchMetadata } from "../store/metadata.ts";
import { finalizeSummary } from "../summary/finalize.ts";

const log = createLogger("android-debug-mcp:recovery");

export type RecoveryOutcomeKind = "recovered" | "blocked_active_owner" | "recovery_failed";

export interface RecoveryOutcome {
  readonly runId: string;
  readonly runDir: string;
  readonly kind: RecoveryOutcomeKind;
  readonly detail: string;
}

export interface RecoveryReport {
  /** Total runs enumerated under runRoot. */
  readonly scanned: number;
  /** Orphans found (`closedAt == null`). */
  readonly orphans: number;
  readonly outcomes: RecoveryOutcome[];
}

/**
 * Orphan recovery (§ C-5) — run once at boot, before the server serves any
 * tool call. An orphan is a run whose `metadata.closedAt` is still null: a
 * prior MCP process died without finalizing it.
 *
 * For each orphan, the tuple lockfile decides:
 *   - lock present + owner process still live → another MCP instance owns this
 *     tuple; leave it (`blocked_active_owner`). Its `start_session` is rejected
 *     by `acquireLock` anyway.
 *   - lock present but owner stale, or no lock at all → the run is provably
 *     dead: replay logcat from the raw truth, finalize as `aborted`, write the
 *     summary, and (stale-lock case) release the lock owner-guarded.
 *
 * Orphans are processed serially in ascending `startedAt` (§ D-M13: same-tuple
 * ordering is required, cross-tuple defaults to serial — a single global
 * ascending pass satisfies both). A single orphan failing is contained: it is
 * logged and recorded, and the scan moves on.
 */
export async function recoverOrphans(runRoot: string): Promise<RecoveryReport> {
  const all = await enumerateRuns(runRoot);
  const orphans = all
    .filter((r) => r.metadata.closedAt === null)
    .sort((a, b) => a.metadata.startedAt.localeCompare(b.metadata.startedAt));

  const outcomes: RecoveryOutcome[] = [];
  for (const orphan of orphans) {
    outcomes.push(await recoverOne(orphan.runDir, orphan.metadata));
  }
  if (orphans.length > 0) {
    log.info("orphan recovery complete", {
      scanned: all.length,
      orphans: orphans.length,
      recovered: outcomes.filter((o) => o.kind === "recovered").length,
      blocked: outcomes.filter((o) => o.kind === "blocked_active_owner").length,
      failed: outcomes.filter((o) => o.kind === "recovery_failed").length,
    });
  }
  return { scanned: all.length, orphans: orphans.length, outcomes };
}

async function recoverOne(runDir: string, metadata: Metadata): Promise<RecoveryOutcome> {
  const runId = metadata.runId;
  const lockPath = lockPathFor(metadata.deviceSerial, metadata.userId, metadata.packageName);

  // Read the lock owner. `readLockOwner` returns null for a missing file
  // (ENOENT) and throws on unreadable JSON; a present file with no valid owner
  // also surfaces as null. § C-5 invariant: a lock that is PRESENT but whose
  // owner cannot be established must NOT be treated as "lock absent" — another
  // process may still own this run, and finalizing it would replay/truncate a
  // live run's logs. Such a run is left for the next boot.
  let owner: LockOwner | null = null;
  let lockError: string | null = null;
  try {
    owner = await readLockOwner(lockPath);
  } catch (err) {
    lockError = String(err);
  }
  if (lockError !== null || (owner === null && (await pathExists(lockPath)))) {
    log.error("orphan lock present but unreadable; not recovering", {
      runId,
      error: lockError ?? "lock file carries no valid owner",
    });
    return {
      runId,
      runDir,
      kind: "recovery_failed",
      detail: `lock unreadable: ${lockError ?? "no valid owner in lock file"}`,
    };
  }

  // § C-5 case 1: the lock owner is still alive — another MCP instance holds
  // this tuple. Do NOT finalize; leave the run to its owner.
  if (owner !== null && isLockOwnerLive(owner)) {
    log.info("orphan left to its live owner", { runId, ownerPid: owner.pid });
    return { runId, runDir, kind: "blocked_active_owner", detail: `held by pid ${owner.pid}` };
  }

  // § C-5 cases 2 (stale lock) + 3 (no lock): the run is provably dead.
  try {
    // Rebuild the derived logs from the raw truth. A replay failure is
    // non-fatal — the run is still finalized as `aborted` below, so it can
    // never masquerade as a healthy/active run in `list_runs`.
    let replay: ReplayResult | null = null;
    let detail: string;
    try {
      replay = await replayParse({
        rawPath: join(runDir, "logcat.raw.txt"),
        logcatJsonlPath: join(runDir, "logcat.jsonl"),
        crashJsonlPath: join(runDir, "crash.jsonl"),
      });
      detail = `replayed ${replay.linesParsed} lines, ${replay.crashMarkers} crash marker(s)`;
    } catch (err) {
      detail = `replay skipped (${String(err)})`;
      log.warn("orphan replayParse failed; finalizing as aborted anyway", {
        runId,
        error: String(err),
      });
    }

    await patchMetadata(runDir, (current) => ({
      ...current,
      status: "aborted",
      closedAt: new Date().toISOString(),
      ...(replay !== null
        ? { crashFound: replay.crashMarkers > 0, linesParsed: replay.linesParsed }
        : {}),
    }));
    await finalizeSummary(runDir).catch((err) => {
      log.warn("orphan finalizeSummary failed", { runId, error: String(err) });
    });
    if (owner !== null) {
      await releaseLockIfOwner(lockPath, owner);
    }

    log.info("orphan recovered", { runId, hadStaleLock: owner !== null });
    return { runId, runDir, kind: "recovered", detail };
  } catch (err) {
    // Reached only when even the metadata patch failed (a real IO fault). The
    // run keeps `closedAt: null` and is retried on the next boot.
    log.error("orphan recovery failed", { runId, error: String(err) });
    return { runId, runDir, kind: "recovery_failed", detail: String(err) };
  }
}

/** True when `path` exists (any type), false when it does not. */
async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
