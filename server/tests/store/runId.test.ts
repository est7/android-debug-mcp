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

  it("generates a distinct suffix for runs minted in the same millisecond", () => {
    // The 4-char suffix is random, so this is inherently probabilistic — the
    // point is only to prove rapid same-millisecond mints differ. A small
    // sample shows that with a negligible (~1e-5) birthday-collision chance;
    // a large sample would be birthday-paradox-flaky for no extra signal.
    const ts = new Date("2026-05-19T10:15:49.821Z");
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(mintRunId(ts));
    expect(ids.size).toBe(10);
  });

  it("rejects malformed run ids via isValidRunId", () => {
    expect(isValidRunId("2026-05-19T10:15:49.821Z_abcd")).toBe(false); // `:` not replaced
    expect(isValidRunId("2026-05-19T10-15-49.821Z_abc")).toBe(false); // 3-char suffix
    expect(isValidRunId("not-a-run-id")).toBe(false);
    expect(isValidRunId("")).toBe(false);
  });
});
