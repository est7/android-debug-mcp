import { describe, expect, it } from "vitest";
import type { LogEntry } from "../../src/logcat/parser.ts";
import { ProcessTracker } from "../../src/logcat/process_tracker.ts";

function amLine(message: string): LogEntry {
  return {
    tsRaw: "05-20 10:15:49.820",
    uid: "1000",
    pid: 932,
    tid: 932,
    level: "I",
    tag: "ActivityManager",
    message,
  };
}

function tracker(packageName: string): ProcessTracker {
  return new ProcessTracker("TESTDEV", packageName, "10100");
}

describe("ProcessTracker.observeSystemLine (P4-P2-4)", () => {
  it("adds the pid for the default process (proc === package)", () => {
    const t = tracker("com.foo");
    t.observeSystemLine(amLine("Start proc 4567:com.foo/u0a100 for top-activity"));
    expect(t.knownPids.has(4567)).toBe(true);
  });

  it("adds the pid for a private `:suffix` process", () => {
    const t = tracker("com.foo");
    t.observeSystemLine(amLine("Start proc 4570:com.foo:remote/u0a100 for service"));
    expect(t.knownPids.has(4570)).toBe(true);
  });

  it("does NOT add a sibling-prefix package's pid", () => {
    const t = tracker("com.foo");
    t.observeSystemLine(amLine("Start proc 9999:com.foobar/u0a200 for top-activity"));
    expect(t.knownPids.has(9999)).toBe(false);
  });

  it("ignores non-ActivityManager lines and non-Start-proc messages", () => {
    const t = tracker("com.foo");
    const notAm: LogEntry = { ...amLine("Start proc 1:com.foo/u0a1 for x"), tag: "MyApp" };
    t.observeSystemLine(notAm);
    t.observeSystemLine(amLine("Displayed com.foo/.MainActivity"));
    expect(t.knownPids.size).toBe(0);
  });

  it("seed pids are retained (grow-only)", () => {
    const t = new ProcessTracker("TESTDEV", "com.foo", "10100", [111, 222]);
    expect(t.knownPids.has(111)).toBe(true);
    t.observeSystemLine(amLine("Start proc 333:com.foo/u0a1 for x"));
    expect([...t.knownPids].sort()).toEqual([111, 222, 333]);
  });
});
