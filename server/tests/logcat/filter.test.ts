import { describe, expect, it } from "vitest";
import { DEFAULT_CRITICAL_TAGS, type FilterContext, shouldKeep } from "../../src/logcat/filter.ts";
import type { LogEntry } from "../../src/logcat/parser.ts";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    tsRaw: "05-20 10:15:49.820",
    uid: null,
    pid: 9999,
    tid: 9999,
    level: "I",
    tag: "SomeRandomTag",
    message: "hello",
    ...overrides,
  };
}

const ctx: FilterContext = {
  appUid: "10100",
  knownPids: new Set([4567, 4600]),
  criticalTags: DEFAULT_CRITICAL_TAGS,
};

describe("shouldKeep (§ C-2)", () => {
  it("keeps a line whose uid matches the app uid", () => {
    expect(shouldKeep(entry({ uid: "10100", pid: 1, tag: "Whatever" }), ctx)).toBe(true);
  });

  it("keeps a line whose pid is a known app pid", () => {
    expect(shouldKeep(entry({ pid: 4567, tag: "Whatever" }), ctx)).toBe(true);
  });

  it("keeps a line tagged with a critical system tag", () => {
    expect(shouldKeep(entry({ pid: 1, tag: "ActivityManager" }), ctx)).toBe(true);
    expect(shouldKeep(entry({ pid: 1, tag: "AndroidRuntime" }), ctx)).toBe(true);
  });

  it("drops an unrelated line (foreign uid, foreign pid, non-critical tag)", () => {
    expect(shouldKeep(entry({ uid: "10999", pid: 1, tag: "SomeRandomTag" }), ctx)).toBe(false);
  });

  it("does not match on uid when the entry has no uid column", () => {
    // uid null → uid clause cannot fire; falls through to pid / tag.
    expect(shouldKeep(entry({ uid: null, pid: 1, tag: "SomeRandomTag" }), ctx)).toBe(false);
  });

  it("does not match on uid when the context appUid is unknown", () => {
    const noUidCtx: FilterContext = { ...ctx, appUid: null };
    expect(shouldKeep(entry({ uid: "10100", pid: 1, tag: "X" }), noUidCtx)).toBe(false);
  });
});
