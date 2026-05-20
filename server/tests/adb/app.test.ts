import { describe, expect, it } from "vitest";
import {
  parseExitInfo,
  parsePidList,
  parsePsForPackage,
  parseResumedActivity,
} from "../../src/adb/app.ts";

describe("parsePidList", () => {
  it("parses space-separated pids from pidof", () => {
    expect(parsePidList("1234 5678 9012\n")).toEqual([1234, 5678, 9012]);
  });
  it("returns empty for blank output", () => {
    expect(parsePidList("")).toEqual([]);
    expect(parsePidList("  \n")).toEqual([]);
  });
});

describe("parsePsForPackage", () => {
  it("extracts the pid of a process whose name equals the package", () => {
    const ps = [
      "USER       PID  PPID     VSZ    RSS WCHAN            ADDR S NAME",
      "u0_a123   4567   789 1234567  98765 0                   0 S com.example.app",
      "u0_a124   4600   789 1234567  98765 0                   0 S com.other.app",
      "root       100     1   10000   2000 0                   0 S init",
    ].join("\n");
    expect(parsePsForPackage(ps, "com.example.app")).toEqual([4567]);
  });

  it("returns empty when the package has no process", () => {
    const ps = "USER PID PPID NAME\nroot 1 0 init\n";
    expect(parsePsForPackage(ps, "com.example.app")).toEqual([]);
  });
});

describe("parseResumedActivity", () => {
  it("parses topResumedActivity form", () => {
    const dump =
      "  topResumedActivity=ActivityRecord{abc1234 u0 com.example.app/.MainActivity t99}";
    expect(parseResumedActivity(dump)).toBe("com.example.app/.MainActivity");
  });

  it("parses mResumedActivity form", () => {
    const dump = "  mResumedActivity: ActivityRecord{def u0 com.foo.bar/com.foo.bar.Home t1}";
    expect(parseResumedActivity(dump)).toBe("com.foo.bar/com.foo.bar.Home");
  });

  it("returns null when no resumed activity is present", () => {
    expect(parseResumedActivity("nothing interesting here")).toBeNull();
  });
});

describe("parseExitInfo", () => {
  it("parses multiple ApplicationExitInfo blocks", () => {
    const dump = [
      "  ApplicationExitInfo #0:",
      "    timestamp=2026-05-19 10:00:00.000",
      "    pid=4567",
      "    reason=10 (USER REQUESTED)",
      "    description=stop com.example.app due to from pid 999",
      "  ApplicationExitInfo #1:",
      "    timestamp=2026-05-18 09:00:00.000",
      "    pid=4000",
      "    reason=6 (CRASH)",
      "    description=force-stop",
    ].join("\n");
    const entries = parseExitInfo(dump);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ pid: 4567, reason: "10 (USER REQUESTED)" });
    expect(entries[1]).toMatchObject({ pid: 4000, reason: "6 (CRASH)" });
  });

  it("returns empty for output without exit-info (older Android)", () => {
    expect(parseExitInfo("Unknown command: exit-info")).toEqual([]);
  });
});
