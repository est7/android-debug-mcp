import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverOrphans } from "../../src/recovery/scan.ts";
import { lockPathFor } from "../../src/store/lock.ts";
import { readMetadata, writeMetadata } from "../../src/store/metadata.ts";

/** A dead pid: 2^31-2 is far above any real process, so `kill(pid,0)` → ESRCH. */
const DEAD_PID = 2_147_483_646;

let runRoot = "";
const lockPaths: string[] = [];

beforeEach(() => {
  runRoot = mkdtempSync(join(tmpdir(), "adm-recovery-"));
});
afterEach(() => {
  rmSync(runRoot, { recursive: true, force: true });
  for (const p of lockPaths.splice(0)) rmSync(p, { force: true });
});

interface RunSpec {
  readonly serial: string;
  readonly pkg: string;
  readonly userId: number;
  readonly runId: string;
  readonly startedAt: string;
  readonly closedAt: string | null;
  /** Omit to leave the run with no logcat.raw.txt (replay-skipped path). */
  readonly raw?: string;
}

async function makeRun(spec: RunSpec): Promise<string> {
  const runDir = join(runRoot, spec.pkg, `u${spec.userId}`, spec.runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  await writeMetadata(runDir, {
    runId: spec.runId,
    deviceSerial: spec.serial,
    userId: spec.userId,
    packageName: spec.pkg,
    runRoot,
    runRootSource: "env",
    startedAt: spec.startedAt,
    closedAt: spec.closedAt,
    status: spec.closedAt === null ? "active" : "stopped",
  });
  for (const f of ["events.jsonl", "commands.jsonl", "logcat.jsonl", "crash.jsonl"]) {
    writeFileSync(join(runDir, f), "");
  }
  if (spec.raw !== undefined) writeFileSync(join(runDir, "logcat.raw.txt"), spec.raw);
  return runDir;
}

/** Plant a lockfile for a tuple with the given owner pid. Tracked for cleanup. */
function writeLock(spec: RunSpec, pid: number): string {
  const path = lockPathFor(spec.serial, spec.userId, spec.pkg);
  writeFileSync(
    path,
    `${JSON.stringify({
      pid,
      runId: spec.runId,
      startedAt: spec.startedAt,
      deviceSerial: spec.serial,
      userId: spec.userId,
      packageName: spec.pkg,
    })}\n`,
  );
  lockPaths.push(path);
  return path;
}

const RAW = "05-20 10:00:00.000   100   100 I App: line one\n";

describe("recoverOrphans — § C-5 decision tree", () => {
  it("case 3: an orphan with no lock is finalized as aborted", async () => {
    const spec: RunSpec = {
      serial: "REC3",
      pkg: "com.test.rec3",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_aaaa",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null,
      raw: RAW,
    };
    const runDir = await makeRun(spec);
    const report = await recoverOrphans(runRoot);

    expect(report.orphans).toBe(1);
    expect(report.outcomes[0]?.kind).toBe("recovered");
    const meta = await readMetadata(runDir);
    expect(meta.status).toBe("aborted");
    expect(meta.closedAt).not.toBeNull();
    expect(statSync(join(runDir, "summary.md")).isFile()).toBe(true);
  });

  it("case 2: an orphan with a stale lock is recovered and its lock removed", async () => {
    const spec: RunSpec = {
      serial: "REC2",
      pkg: "com.test.rec2",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_bbbb",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null,
      raw: RAW,
    };
    const runDir = await makeRun(spec);
    const lockPath = writeLock(spec, DEAD_PID);
    const report = await recoverOrphans(runRoot);

    expect(report.outcomes[0]?.kind).toBe("recovered");
    expect((await readMetadata(runDir)).status).toBe("aborted");
    expect(() => statSync(lockPath)).toThrow(); // stale lock unlinked
  });

  it("case 1: an orphan whose lock owner is alive is left untouched", async () => {
    const spec: RunSpec = {
      serial: "REC1",
      pkg: "com.test.rec1",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_cccc",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null,
      raw: RAW,
    };
    const runDir = await makeRun(spec);
    const lockPath = writeLock(spec, process.pid); // this test process — alive
    const report = await recoverOrphans(runRoot);

    expect(report.outcomes[0]?.kind).toBe("blocked_active_owner");
    const meta = await readMetadata(runDir);
    expect(meta.status).toBe("active"); // NOT finalized
    expect(meta.closedAt).toBeNull();
    expect(statSync(lockPath).isFile()).toBe(true); // live lock kept
  });

  it("ignores already-closed runs", async () => {
    await makeRun({
      serial: "RECC",
      pkg: "com.test.recc",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_dddd",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: "2026-05-20T10:05:00.000Z",
      raw: RAW,
    });
    const report = await recoverOrphans(runRoot);
    expect(report.scanned).toBe(1);
    expect(report.orphans).toBe(0);
  });

  it("recovers multiple orphans, oldest first", async () => {
    await makeRun({
      serial: "RECM",
      pkg: "com.test.recm",
      userId: 0,
      runId: "2026-05-20T10-05-00.000Z_late",
      startedAt: "2026-05-20T10:05:00.000Z",
      closedAt: null,
      raw: RAW,
    });
    await makeRun({
      serial: "RECM",
      pkg: "com.test.recm2",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_erly",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null,
      raw: RAW,
    });
    const report = await recoverOrphans(runRoot);
    expect(report.orphans).toBe(2);
    expect(report.outcomes.map((o) => o.kind)).toEqual(["recovered", "recovered"]);
    // ascending startedAt: the 10:00 run is processed before the 10:05 run.
    expect(report.outcomes[0]?.runId).toBe("2026-05-20T10-00-00.000Z_erly");
  });

  it("replay failure is non-fatal — a run with no raw log still finalizes as aborted", async () => {
    const spec: RunSpec = {
      serial: "RECN",
      pkg: "com.test.recn",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_eeee",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null, // no `raw` → logcat.raw.txt absent → replayParse throws
    };
    const runDir = await makeRun(spec);
    const report = await recoverOrphans(runRoot);

    expect(report.outcomes[0]?.kind).toBe("recovered");
    expect((await readMetadata(runDir)).status).toBe("aborted");
  });

  it("a present but corrupt lock file blocks recovery — the run is left untouched", async () => {
    const spec: RunSpec = {
      serial: "RECX",
      pkg: "com.test.recx",
      userId: 0,
      runId: "2026-05-20T10-00-00.000Z_ffff",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: null,
      raw: RAW,
    };
    const runDir = await makeRun(spec);
    // A logcat.jsonl with a sentinel — replayParse would truncate it.
    writeFileSync(join(runDir, "logcat.jsonl"), '{"sentinel":true}\n');
    // A lock file that is PRESENT but not valid owner JSON.
    const lockPath = lockPathFor(spec.serial, spec.userId, spec.pkg);
    writeFileSync(lockPath, "}{ corrupt not-json");
    lockPaths.push(lockPath);

    const report = await recoverOrphans(runRoot);

    // § C-5: an unreadable owner must NOT be treated as "lock absent".
    expect(report.outcomes[0]?.kind).toBe("recovery_failed");
    const meta = await readMetadata(runDir);
    expect(meta.status).toBe("active"); // not finalized
    expect(meta.closedAt).toBeNull();
    // Logs untouched — no replay / truncate happened.
    expect(readFileSync(join(runDir, "logcat.jsonl"), "utf8")).toContain("sentinel");
  });
});
