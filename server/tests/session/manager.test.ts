import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type StartSessionInput } from "../../src/session/manager.ts";
import type { Session } from "../../src/session/session.ts";
import { AppendStream } from "../../src/store/jsonl.ts";

let scratch = "";
let serialCounter = 0;
let started: Session[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-mgr-"));
  started = [];
});

afterEach(async () => {
  // Finalize anything still active so global lockfiles are released.
  for (const s of started) {
    if (s.isActive) await s.finalize("stopped").catch(() => undefined);
  }
  rmSync(scratch, { recursive: true, force: true });
});

function uniqueSerial(): string {
  return `TESTMGR-${process.pid}-${serialCounter++}`;
}

function startInput(overrides: Partial<StartSessionInput> = {}): StartSessionInput {
  return {
    deviceSerial: uniqueSerial(),
    userId: 0,
    packageName: "com.example.app",
    runRoot: scratch,
    runRootSource: "fallback",
    projectRoot: null,
    profile: null,
    ...overrides,
  };
}

async function track(mgr: SessionManager, input: StartSessionInput): Promise<Session> {
  const s = await mgr.start(input);
  started.push(s);
  return s;
}

/**
 * Wait until the manager's registry is fully drained. Neither `isActive` nor
 * `listActive()` is a safe signal: `finalize()` flips the status (and thus
 * drops the session from `listActive()`) at its *start*, before its fs I/O and
 * before `teardown()`'s `unregister()`. `registeredCount()` only reaches 0
 * once `unregister()` has run, i.e. after the whole teardown settled.
 */
async function waitForDrained(mgr: SessionManager, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (mgr.registeredCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("SessionManager.start", () => {
  it("creates a session with a run folder and active status", async () => {
    const mgr = new SessionManager();
    const session = await track(mgr, startInput());
    expect(session.runId).toMatch(/_[A-Za-z0-9]{4}$/);
    expect(session.isActive).toBe(true);
    expect(session.runDir).toContain(scratch);
  });

  it("rejects a second session for the same tuple with singleton_violation", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    await track(mgr, startInput({ deviceSerial: serial }));
    await expect(mgr.start(startInput({ deviceSerial: serial }))).rejects.toMatchObject({
      name: "ToolDomainError",
      code: "singleton_violation",
    });
  });

  it("allows concurrent sessions for different tuples", async () => {
    const mgr = new SessionManager();
    const a = await track(mgr, startInput());
    const b = await track(mgr, startInput());
    expect(a.runId).not.toBe(b.runId);
    expect(mgr.listActive()).toHaveLength(2);
  });

  it("frees the tuple after stop so the same tuple can start again", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    const first = await track(mgr, startInput({ deviceSerial: serial }));
    await mgr.stop(first);
    const second = await track(mgr, startInput({ deviceSerial: serial }));
    expect(second.isActive).toBe(true);
  });

  // v2-G Phase 3 / codex audit M1: see the "Failure cleanup (codex Phase 3
  // audit M1)" comment block in SessionManager.start for the rationale and the
  // exact cleanup site. Regression-test gap (deferred): triggering a real
  // mkdir failure inside the precreate loop without invasive ESM mocks is not
  // tractable today — node:fs/promises.mkdir is a frozen ESM export so vi.spyOn
  // fails with "Cannot redefine property: mkdir"; pre-placing a file at the
  // collision point requires predicting the freshly-minted runId; and routing
  // the manager through a dep-injected mkdir would invert prod control flow
  // only for this test. "frees the tuple after stop so the same tuple can
  // start again" exercises the post-finalize cleanup symmetry.
});

describe("SessionManager.resolveForStop (§ D-M7)", () => {
  it("throws no_active_session when nothing is running", () => {
    const mgr = new SessionManager();
    expect(() => mgr.resolveForStop(undefined)).toThrow(/no active session/i);
  });

  it("returns the sole session when runId is omitted", async () => {
    const mgr = new SessionManager();
    const session = await track(mgr, startInput());
    expect(mgr.resolveForStop(undefined)).toBe(session);
  });

  it("throws ambiguous_active_session when 2+ are active and runId is omitted", async () => {
    const mgr = new SessionManager();
    await track(mgr, startInput());
    await track(mgr, startInput());
    expect(() => mgr.resolveForStop(undefined)).toThrow(/ambiguous|active/i);
    try {
      mgr.resolveForStop(undefined);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("ambiguous_active_session");
    }
  });

  it("throws run_missing for an unknown runId", () => {
    const mgr = new SessionManager();
    expect(() => mgr.resolveForStop("2026-05-19T10-15-49.821Z_zzzz")).toThrow();
  });
});

describe("Session event recording (redaction-aware)", () => {
  it("appendEvent stamps ts and redacts sensitive payload keys", async () => {
    const mgr = new SessionManager();
    const session = await track(mgr, startInput());
    await session.appendEvent({
      type: "mark",
      name: "before_login",
      payload: { password: "hunter2", username: "alice" },
    });
    await mgr.stop(session);
    const events = readFileSync(join(session.runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const mark = events.find((e) => e.type === "mark");
    expect(mark).toBeDefined();
    expect(mark?.ts).toMatch(/^\d{4}-/);
    expect((mark?.payload as Record<string, unknown>).password).toBe("***");
    expect((mark?.payload as Record<string, unknown>).username).toBe("alice");
  });
});

describe("SessionManager lifecycle failure paths", () => {
  it("frees the tuple even when finalize fails (P3-P1-2)", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    const session = await track(mgr, startInput({ deviceSerial: serial }));
    // Make finalize fail: deleting the run dir makes patchMetadata's
    // readMetadata ENOENT. The lock release in finalize's own finally still
    // runs, and the manager must still unregister the tuple.
    rmSync(session.runDir, { recursive: true, force: true });
    await expect(mgr.stop(session)).rejects.toBeTruthy();
    expect(session.isActive).toBe(false);
    expect(mgr.listActive()).toHaveLength(0);
    // Tuple freed → a fresh start for the same tuple must succeed.
    const again = await track(mgr, startInput({ deviceSerial: serial }));
    expect(again.isActive).toBe(true);
  });

  it("abort() frees the tuple (used by start_session post-registration cleanup, P3-P1-1)", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    const session = await track(mgr, startInput({ deviceSerial: serial }));
    await mgr.abort(session);
    expect(session.currentStatus).toBe("aborted");
    expect(mgr.listActive()).toHaveLength(0);
    const again = await track(mgr, startInput({ deviceSerial: serial }));
    expect(again.isActive).toBe(true);
  });

  it("stop() still tears down + frees the tuple when the session_stop event write fails (P3-R2-P1)", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    const session = await track(mgr, startInput({ deviceSerial: serial }));
    // The session_stop append is the first AppendStream.append() inside stop().
    vi.spyOn(AppendStream.prototype, "append").mockRejectedValueOnce(
      new Error("simulated append failure"),
    );
    await mgr.stop(session);
    vi.restoreAllMocks();
    expect(session.currentStatus).toBe("stopped");
    expect(mgr.registeredCount()).toBe(0);
    // Tuple freed despite the failed closing-event write.
    const again = await track(mgr, startInput({ deviceSerial: serial }));
    expect(again.isActive).toBe(true);
  });
});

describe("SessionManager auto-stop via timers", () => {
  it("auto-stops the session and writes auto_stopped_by_timeout when the idle cap fires", async () => {
    const mgr = new SessionManager();
    let session: Session;
    vi.useFakeTimers();
    try {
      mgr.setTimerCapsForTesting({ hardCapMs: 10_000, idleCapMs: 50 });
      session = await mgr.start(startInput());
      started.push(session);
      expect(session.isActive).toBe(true);
      // Advance fake time to fire the idle timer's callback.
      await vi.advanceTimersByTimeAsync(60);
    } finally {
      // handleTimeout() does real fs I/O (appendEvent + finalize) that fake
      // timers cannot flush — wait for it on real timers.
      vi.useRealTimers();
    }
    await waitForDrained(mgr);
    expect(session.isActive).toBe(false);
    expect(mgr.listActive()).toHaveLength(0);
    const events = readFileSync(join(session.runDir, "events.jsonl"), "utf8");
    expect(events).toContain("auto_stopped_by_timeout");
  });

  it("auto-stop still finalizes + frees the tuple when the timeout-event write fails (P3-P1-3)", async () => {
    const mgr = new SessionManager();
    const serial = uniqueSerial();
    let session: Session;
    vi.useFakeTimers();
    try {
      mgr.setTimerCapsForTesting({ hardCapMs: 10_000, idleCapMs: 50 });
      session = await mgr.start(startInput({ deviceSerial: serial }));
      started.push(session);
      // The auto_stopped_by_timeout append is the next AppendStream.append()
      // call after start — force it to reject.
      vi.spyOn(AppendStream.prototype, "append").mockRejectedValueOnce(
        new Error("simulated append failure"),
      );
      await vi.advanceTimersByTimeAsync(60);
    } finally {
      vi.useRealTimers();
    }
    await waitForDrained(mgr);
    vi.restoreAllMocks();
    expect(session.isActive).toBe(false);
    expect(mgr.listActive()).toHaveLength(0);
    // Tuple freed despite the failed event write.
    const again = await track(mgr, startInput({ deviceSerial: serial }));
    expect(again.isActive).toBe(true);
  });
});
