import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../mcp/log.ts";
import {
  assertSafeDeviceSerial,
  assertSafePackageName,
  assertSafeRunId,
  assertSafeUserId,
} from "./identity.ts";
import { AppendStream } from "./jsonl.ts";
import {
  type Metadata,
  type MetadataInput,
  type RunStatus,
  readMetadata,
  writeMetadata,
} from "./metadata.ts";
import type { RunRootSource } from "./paths.ts";
import { writeRunIndex } from "./runIndex.ts";

const log = createLogger("store:run");

export interface RunFolderInput {
  readonly runRoot: string;
  readonly runRootSource: RunRootSource;
  /** Resolved source-tree root (v2-A chain M), or null outside a git checkout. */
  readonly projectRoot: string | null;
  readonly packageName: string;
  readonly userId: number;
  readonly runId: string;
  readonly deviceSerial: string;
  readonly startedAt: Date;
}

export interface RunFolder {
  readonly runId: string;
  readonly runDir: string;
  readonly artifactsDir: string;
  readonly metadata: Metadata;
  readonly streams: RunStreams;
  /** Flush + close all open jsonl streams. Safe to call multiple times. */
  closeStreams(): Promise<void>;
}

export interface RunStreams {
  readonly events: AppendStream;
  readonly commands: AppendStream;
  readonly logcat: AppendStream;
  readonly crash: AppendStream;
}

export const RUN_JSONL_NAMES = ["events", "commands", "logcat", "crash"] as const;
export type RunJsonlName = (typeof RUN_JSONL_NAMES)[number];

/**
 * Materialize the on-disk layout for a single run:
 *
 * ```
 * <runRoot>/<package>/u<userId>/<runId>/
 *   metadata.json
 *   events.jsonl       (empty)
 *   commands.jsonl     (empty)
 *   logcat.jsonl       (empty)
 *   crash.jsonl        (empty)
 *   artifacts/         (empty dir)
 * ```
 *
 * Per § D-M8, `u<userId>` segment isolates runs across Android user profiles
 * (work profile = u10/u11; primary = u0). Per § C-3, callers must already
 * have resolved `runRoot` via `resolveRunRoot()` and pass through `runRootSource`
 * so it can be recorded in metadata.
 */
export async function createRunDir(input: RunFolderInput): Promise<RunFolder> {
  assertSafeRunFolderInput(input);
  const runDir = runPath(input);
  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const metadata = await writeMetadata(runDir, initialMetadata(input));
  // Best-effort: register in the host-global run-index so cross-runRoot
  // lookups can find this run after it stops (§ 1.1-D backlog). A symlink
  // write that fails (read-only FS, EACCES, ...) degrades only the
  // cross-runRoot path — the run itself is intact.
  try {
    await writeRunIndex(input.runId, runDir);
  } catch (err) {
    log.warn("run-index write failed; cross-runRoot lookup will fall back to scan", {
      runId: input.runId,
      runDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const streams = await openStreams(runDir);
  return makeFolder(runDir, artifactsDir, metadata, streams);
}

export function runPath(
  input: Pick<RunFolderInput, "runRoot" | "packageName" | "userId" | "runId">,
): string {
  assertSafeRunPathParts(input);
  return join(input.runRoot, input.packageName, `u${input.userId}`, input.runId);
}

export async function runExists(
  input: Pick<RunFolderInput, "runRoot" | "packageName" | "userId" | "runId">,
): Promise<boolean> {
  try {
    const s = await stat(runPath(input));
    return s.isDirectory();
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return false;
    throw err;
  }
}

function assertSafeRunPathParts(
  input: Pick<RunFolderInput, "packageName" | "userId" | "runId">,
): void {
  assertSafePackageName(input.packageName);
  assertSafeUserId(input.userId);
  assertSafeRunId(input.runId);
}

/**
 * Delete every *closed* run directory for `packageName` under `runRoot`
 * (§ D-M9 `clearLocalRunLogs`). "Closed" = `metadata.closedAt != null`; this
 * filter inherently skips active runs (closedAt null) and orphans (closedAt
 * null but process dead — left for Phase 8 recovery). Run dirs without a
 * readable `metadata.json` are skipped. Returns the deleted run-dir paths.
 */
export async function clearClosedRuns(runRoot: string, packageName: string): Promise<string[]> {
  assertSafePackageName(packageName);
  const pkgDir = join(runRoot, packageName);
  const deleted: string[] = [];
  for (const userDir of await safeReaddir(pkgDir)) {
    const uPath = join(pkgDir, userDir);
    for (const runDir of await safeReaddir(uPath)) {
      const runPathAbs = join(uPath, runDir);
      let closed = false;
      try {
        const meta = await readMetadata(runPathAbs);
        closed = meta.closedAt !== null;
      } catch {
        // No / unreadable metadata.json → not a well-formed closed run; skip.
        continue;
      }
      if (closed) {
        await rm(runPathAbs, { recursive: true, force: true });
        deleted.push(runPathAbs);
      }
    }
  }
  return deleted;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
}

function assertSafeRunFolderInput(input: RunFolderInput): void {
  assertSafeRunPathParts(input);
  assertSafeDeviceSerial(input.deviceSerial);
}

function initialMetadata(input: RunFolderInput): MetadataInput {
  const status: RunStatus = "active";
  return {
    runId: input.runId,
    deviceSerial: input.deviceSerial,
    userId: input.userId,
    packageName: input.packageName,
    runRoot: input.runRoot,
    runRootSource: input.runRootSource,
    projectRoot: input.projectRoot,
    startedAt: input.startedAt.toISOString(),
    closedAt: null,
    status,
    app: { versionName: null, versionCode: null },
    device: { model: null, apiLevel: null, abi: null, buildFingerprint: null },
    git: { sha: null, dirty: null },
    logcatBuffer: { requested: null, effective: null, buffers: [], error: null },
    exitCode: null,
    signalCode: null,
    killed: null,
    bytesRead: 0,
    linesParsed: 0,
    crashFound: false,
  };
}

async function openStreams(runDir: string): Promise<RunStreams> {
  // Sequential open with explicit partial-cleanup: if the Nth open rejects,
  // close the first N-1 streams before rethrowing so we don't leak file
  // handles. Promise.all() would leave the partial successes dangling
  // (their file descriptors remain open until GC, which is non-deterministic).
  const opened: AppendStream[] = [];
  try {
    for (const name of RUN_JSONL_NAMES) {
      opened.push(await AppendStream.open(join(runDir, `${name}.jsonl`)));
    }
    const [events, commands, logcat, crash] = opened;
    if (!events || !commands || !logcat || !crash) {
      throw new Error("openStreams: missing stream after sequential open.");
    }
    return { events, commands, logcat, crash };
  } catch (err) {
    await Promise.allSettled(opened.map((s) => s.close()));
    throw err;
  }
}

function makeFolder(
  runDir: string,
  artifactsDir: string,
  metadata: Metadata,
  streams: RunStreams,
): RunFolder {
  let closed = false;
  return {
    runId: metadata.runId,
    runDir,
    artifactsDir,
    metadata,
    streams,
    async closeStreams(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.all([
        streams.events.close(),
        streams.commands.close(),
        streams.logcat.close(),
        streams.crash.close(),
      ]);
    },
  };
}
