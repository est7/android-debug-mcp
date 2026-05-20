import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCrashContext } from "../../src/search/crash_context.ts";

const BUDGET = 23_000;

// A raw logcat with a java crash, a native crash, and an ANR at known lines.
const RAW_LINES = [
  /*  1 */ "05-20 10:00:01.000   100   100 I App: starting up",
  /*  2 */ "05-20 10:00:02.000   100   100 D Net: issuing request",
  /*  3 */ "05-20 10:00:03.000   100   100 E AndroidRuntime: FATAL EXCEPTION: main",
  /*  4 */ "05-20 10:00:03.000   100   100 E AndroidRuntime: Process: com.example.app, PID: 100",
  /*  5 */ "05-20 10:00:03.000   100   100 E AndroidRuntime: java.lang.NullPointerException: read field on null",
  /*  6 */ "05-20 10:00:03.000   100   100 E AndroidRuntime: \tat com.example.app.MainActivity.onCreate(MainActivity.java:42)",
  /*  7 */ "05-20 10:00:03.000   100   100 E AndroidRuntime: \tat android.app.Activity.performCreate(Activity.java:8000)",
  /*  8 */ "05-20 10:00:04.000   100   100 I App: unrelated line",
  /*  9 */ "05-20 10:00:05.000   500   500 F libc: Fatal signal 11 (SIGSEGV), code 1, fault addr 0x0 in tid 500",
  /* 10 */ "05-20 10:00:05.000   500   500 F DEBUG: *** *** *** *** *** *** *** *** *** *** ***",
  /* 11 */ "05-20 10:00:05.000   500   500 F DEBUG: signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0",
  /* 12 */ "05-20 10:00:05.000   500   500 F DEBUG: \t#00 pc 00012345  /system/lib/libfoo.so (bar+16)",
  /* 13 */ "05-20 10:00:06.000   200   200 E ActivityManager: ANR in com.example.app (com.example.app/.MainActivity)",
  /* 14 */ "05-20 10:00:06.000   200   200 E ActivityManager: Reason: Input dispatching timed out",
  /* 15 */ "05-20 10:00:06.000   200   200 E ActivityManager: \tat com.example.app.Worker.block(Worker.java:10)",
  /* 16 */ "05-20 10:00:07.000   100   100 I App: shutting down",
];

const CRASHES = [
  { rawLineNo: 3, type: "java", marker: "FATAL EXCEPTION", line: RAW_LINES[2] },
  { rawLineNo: 9, type: "native", marker: "Fatal signal", line: RAW_LINES[8] },
  { rawLineNo: 13, type: "anr", marker: "ANR in", line: RAW_LINES[12] },
];

let runDir = "";

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "adm-crash-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function writeRun(crashes: ReadonlyArray<Record<string, unknown>>): void {
  writeFileSync(join(runDir, "logcat.raw.txt"), `${RAW_LINES.join("\n")}\n`);
  writeFileSync(join(runDir, "crash.jsonl"), crashes.map((c) => JSON.stringify(c)).join("\n"));
}

describe("extractCrashContext signature parsing", () => {
  it("parses a java crash — exception + top frame", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 0, beforeLines: 3, afterLines: 5 },
      BUDGET,
    );
    expect(r.crashCount).toBe(3);
    expect(r.type).toBe("java");
    expect(r.mainException).toContain("NullPointerException");
    expect(r.topFrame).toContain("MainActivity.onCreate");
    expect(r.snippet).toContain("FATAL EXCEPTION");
  });

  it("parses a native crash — signal + first backtrace frame", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 1, beforeLines: 2, afterLines: 5 },
      BUDGET,
    );
    expect(r.type).toBe("native");
    expect(r.mainException).toMatch(/signal 11 \(SIGSEGV\)/);
    expect(r.topFrame).toContain("#00 pc");
  });

  it("parses an ANR — reason + first frame", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 2, beforeLines: 2, afterLines: 3 },
      BUDGET,
    );
    expect(r.type).toBe("anr");
    expect(r.mainException).toContain("ANR in com.example.app");
    expect(r.topFrame).toContain("Worker.block");
  });
});

describe("extractCrashContext window", () => {
  it("slices the requested ±N window and reports its line range", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 0, beforeLines: 2, afterLines: 2 },
      BUDGET,
    );
    expect(r.snippetRange).toEqual({ from: 1, to: 5 });
    expect(r.snippet?.split("\n")).toHaveLength(5);
  });

  it("clamps the window at the start of the file", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 0, beforeLines: 100, afterLines: 0 },
      BUDGET,
    );
    expect(r.snippetRange?.from).toBe(1);
  });
});

describe("extractCrashContext edge cases", () => {
  it("returns {crashCount: 0} for a run with no crash — not an error", async () => {
    writeRun([]);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 0, beforeLines: 50, afterLines: 50 },
      BUDGET,
    );
    expect(r).toEqual({ crashCount: 0 });
  });

  it("throws invalid_argument when crashIndex exceeds the crash count", async () => {
    writeRun(CRASHES);
    await expect(
      extractCrashContext(runDir, { crashIndex: 9, beforeLines: 10, afterLines: 10 }, BUDGET),
    ).rejects.toThrow(/out of range/);
  });

  it("shrinks the snippet around the marker and flags truncation under a tight budget", async () => {
    writeRun(CRASHES);
    const r = await extractCrashContext(
      runDir,
      { crashIndex: 0, beforeLines: 10, afterLines: 10 },
      200,
    );
    expect(r.truncated).toBe(true);
    expect(r.truncationMessage).toBeDefined();
    expect(r.snippet).toContain("FATAL EXCEPTION");
    expect((r.snippet ?? "").length).toBeLessThanOrEqual(200 + 32);
  });
});
