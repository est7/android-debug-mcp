import { describe, expect, it } from "vitest";
import { logcatTsToEpochMs } from "../../src/logcat/ts.ts";

function epochForLocalIso(iso: string): number {
  return new Date(iso).getTime();
}

describe("logcatTsToEpochMs", () => {
  it("converts a same-year device-local timestamp to epoch ms", () => {
    const sessionStartMs = epochForLocalIso("2026-05-20T10:00:00.000+08:00");

    expect(logcatTsToEpochMs("05-20 10:15:49.820", sessionStartMs, "Asia/Shanghai")).toBe(
      epochForLocalIso("2026-05-20T10:15:49.820+08:00"),
    );
  });

  it("chooses the previous year for December logs near a January session", () => {
    const sessionStartMs = epochForLocalIso("2026-01-01T00:00:10.000+08:00");

    expect(logcatTsToEpochMs("12-31 23:59:59.999", sessionStartMs, "Asia/Shanghai")).toBe(
      epochForLocalIso("2025-12-31T23:59:59.999+08:00"),
    );
  });

  it("handles DST offsets for valid local times in America/New_York", () => {
    const sessionStartMs = epochForLocalIso("2026-03-08T04:00:00.000-04:00");

    expect(logcatTsToEpochMs("03-08 03:30:00.000", sessionStartMs, "America/New_York")).toBe(
      epochForLocalIso("2026-03-08T03:30:00.000-04:00"),
    );
  });

  it("returns null for malformed tsRaw values", () => {
    const sessionStartMs = epochForLocalIso("2026-05-20T10:00:00.000+08:00");

    expect(logcatTsToEpochMs("05-20 10:15:49", sessionStartMs, "Asia/Shanghai")).toBeNull();
    expect(logcatTsToEpochMs("not a logcat timestamp", sessionStartMs, "Asia/Shanghai")).toBeNull();
  });

  it("returns null for invalid time zones", () => {
    const sessionStartMs = epochForLocalIso("2026-05-20T10:00:00.000+08:00");

    expect(logcatTsToEpochMs("05-20 10:15:49.820", sessionStartMs, "Not/A_Zone")).toBeNull();
  });
});
