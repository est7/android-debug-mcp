import { describe, expect, it } from "vitest";
import { isValidRunId, mintRunId } from "../../src/store/runId.ts";

describe("runId", () => {
  it("mints a value that matches the canonical format", () => {
    const id = mintRunId(new Date("2026-05-19T10:15:49.821Z"));
    expect(id).toMatch(/^2026-05-19T10-15-49\.821Z_[A-Za-z0-9]{4}$/);
    expect(isValidRunId(id)).toBe(true);
  });

  it("replaces every `:` so the value is filename-safe on Windows", () => {
    const id = mintRunId(new Date("2026-12-31T23:59:59.000Z"));
    expect(id).not.toContain(":");
  });

  it("generates unique suffixes within the same millisecond", () => {
    const ts = new Date("2026-05-19T10:15:49.821Z");
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) ids.add(mintRunId(ts));
    expect(ids.size).toBe(500);
  });

  it("rejects malformed run ids via isValidRunId", () => {
    expect(isValidRunId("2026-05-19T10:15:49.821Z_abcd")).toBe(false); // `:` not replaced
    expect(isValidRunId("2026-05-19T10-15-49.821Z_abc")).toBe(false); // 3-char suffix
    expect(isValidRunId("not-a-run-id")).toBe(false);
    expect(isValidRunId("")).toBe(false);
  });
});
