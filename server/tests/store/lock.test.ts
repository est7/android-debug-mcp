import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LockDeps, acquireLock, lockPathFor, readLockOwner } from "../../src/store/lock.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-lock-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function input(overrides: Partial<Parameters<typeof acquireLock>[0]> = {}) {
  return {
    deviceSerial: "TESTDEV1",
    userId: 0,
    packageName: "com.example.app",
    runId: "2026-05-19T10-15-49.821Z_abcd",
    startedAt: new Date("2026-05-19T10:15:49.821Z"),
    ...overrides,
  };
}

const aliveDeps: LockDeps = {
  isPidAlive: () => true,
  getProcessStartMs: () => null,
};

const deadDeps: LockDeps = {
  isPidAlive: () => false,
  getProcessStartMs: () => null,
};

describe("acquireLock", () => {
  it("creates a lock file and exposes its owner record", async () => {
    const handle = await acquireLock(input(), aliveDeps);
    expect(handle.owner.pid).toBe(process.pid);
    expect(handle.owner.runId).toBe("2026-05-19T10-15-49.821Z_abcd");
    const onDisk = await readLockOwner(handle.path);
    expect(onDisk?.pid).toBe(process.pid);
    await handle.release();
  });

  it("rejects with lock_held_by_active_owner when an alive pid holds the lock", async () => {
    const first = await acquireLock(input(), aliveDeps);
    try {
      await expect(
        acquireLock(input({ runId: "2026-05-19T10-15-49.822Z_zzzz" }), aliveDeps),
      ).rejects.toMatchObject({
        name: "LockError",
        code: "lock_held_by_active_owner",
      });
    } finally {
      await first.release();
    }
  });

  it("evicts and re-acquires a stale lock (pid not alive)", async () => {
    const first = await acquireLock(input(), aliveDeps);
    await first.release();
    // Manually re-plant a stale lockfile with a phantom pid.
    const lockPath = lockPathFor("TESTDEV1", 0, "com.example.app");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 999_999_999,
        runId: "stale_run",
        startedAt: "2026-05-19T10:00:00.000Z",
        deviceSerial: "TESTDEV1",
        userId: 0,
        packageName: "com.example.app",
      })}\n`,
    );
    const handle = await acquireLock(input(), deadDeps);
    expect(handle.owner.pid).toBe(process.pid);
    expect(handle.owner.runId).toBe("2026-05-19T10-15-49.821Z_abcd");
    await handle.release();
  });

  it("evicts on force:true even when the prior owner appears alive (owner-guard: first.release() last is a no-op)", async () => {
    const first = await acquireLock(input(), aliveDeps);
    const second = await acquireLock(
      input({ force: true, runId: "2026-05-19T10-16-00.000Z_AAAA" }),
      aliveDeps,
    );
    expect(second.owner.runId).toBe("2026-05-19T10-16-00.000Z_AAAA");

    // CRITICAL: release the OLD handle first. Without owner-guard this would
    // delete second's live lock; with owner-guard it must be a silent no-op
    // and the second lock remains intact.
    await first.release();
    const stillOwnedBySecond = await readLockOwner(second.path);
    expect(stillOwnedBySecond?.runId).toBe("2026-05-19T10-16-00.000Z_AAAA");

    await second.release();
    expect(await readLockOwner(second.path)).toBeNull();
  });

  it("rejects with lock_owner_unreadable when the lockfile is corrupt", async () => {
    const lockPath = lockPathFor("TESTDEV1", 0, "com.example.app");
    writeFileSync(lockPath, "<<<not json>>>\n");
    await expect(acquireLock(input(), aliveDeps)).rejects.toMatchObject({
      name: "LockError",
      code: "lock_owner_unreadable",
    });
    rmSync(lockPath, { force: true });
  });

  it("detects PID-recycle: pid alive but processStartMs mismatch → treated as stale", async () => {
    // Plant a lock that claims processStartMs=1000.
    const lockPath = lockPathFor("TESTDEV1", 0, "com.example.app");
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 12345,
        runId: "stale_run",
        startedAt: "2026-05-19T10:00:00.000Z",
        deviceSerial: "TESTDEV1",
        userId: 0,
        packageName: "com.example.app",
        processStartMs: 1000,
      })}\n`,
    );
    // Recycled pid: alive, but its start time is different.
    const recycledDeps: LockDeps = {
      isPidAlive: () => true,
      getProcessStartMs: vi.fn().mockImplementation((pid) => (pid === process.pid ? 5000 : 9999)),
    };
    const handle = await acquireLock(input(), recycledDeps);
    expect(handle.owner.pid).toBe(process.pid);
    await handle.release();
  });

  it("release() is idempotent", async () => {
    const handle = await acquireLock(input(), aliveDeps);
    await handle.release();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

describe("readLockOwner", () => {
  it("returns null when the lock file does not exist", async () => {
    const lockPath = lockPathFor("NOPE", 0, "com.nope");
    rmSync(lockPath, { force: true });
    expect(await readLockOwner(lockPath)).toBeNull();
  });
});

describe("acquireLock + lockPathFor identity validation", () => {
  it("rejects an identity that would escape the locks root via `..`", async () => {
    await expect(acquireLock(input({ deviceSerial: "../evil" }), aliveDeps)).rejects.toMatchObject({
      name: "IdentityError",
      code: "invalid_device_serial",
    });
    await expect(
      acquireLock(input({ packageName: "com.foo/etc" }), aliveDeps),
    ).rejects.toMatchObject({ name: "IdentityError", code: "invalid_package_name" });
  });

  it("rejects a runId that did not come from mintRunId", async () => {
    await expect(acquireLock(input({ runId: "../etc/passwd" }), aliveDeps)).rejects.toMatchObject({
      name: "IdentityError",
      code: "invalid_run_id",
    });
  });
});
