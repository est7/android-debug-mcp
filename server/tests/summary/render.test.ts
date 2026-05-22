import { describe, expect, it } from "vitest";
import type { RunData } from "../../src/summary/collect.ts";
import { renderSummary } from "../../src/summary/render.ts";

function makeRunData(overrides: Partial<RunData> = {}): RunData {
  return {
    metadata: {
      runId: "2026-05-20T10-00-00.000Z_TEST",
      deviceSerial: "SERIAL01",
      userId: 0,
      packageName: "com.example.app",
      runRoot: "/tmp/runs",
      runRootSource: "env",
      startedAt: "2026-05-20T10:00:00.000Z",
      closedAt: "2026-05-20T10:05:00.000Z",
      status: "stopped",
      app: { versionName: "1.2.3", versionCode: "123" },
      device: { model: "Pixel", apiLevel: 33, abi: "arm64-v8a", buildFingerprint: "fp" },
      git: { sha: "abc1234", dirty: true },
      logcatBuffer: { requested: "16M", effective: "16M", buffers: ["main"], error: null },
      exitCode: 0,
      signalCode: null,
      killed: false,
      bytesRead: 1024,
      linesParsed: 50,
      crashFound: false,
    },
    counts: { events: 3, commands: 2, logcatLines: 50, crashes: 0 },
    events: [],
    crashes: [],
    ...overrides,
  };
}

describe("renderSummary", () => {
  it("renders identity, app, device, git provenance", () => {
    const md = renderSummary(makeRunData());
    expect(md).toContain("# Run Summary — com.example.app");
    expect(md).toContain("2026-05-20T10-00-00.000Z_TEST");
    expect(md).toContain("1.2.3");
    expect(md).toContain("Pixel");
    expect(md).toContain("API 33");
    expect(md).toContain("abc1234 (dirty)");
  });

  it("renders the counts line", () => {
    const md = renderSummary(makeRunData());
    expect(md).toContain("Events 3 · Commands 2 · Logcat lines 50 · Crashes 0");
  });

  it("says so when there are no crashes", () => {
    expect(renderSummary(makeRunData())).toContain("No crashes detected.");
  });

  it("lists crashes when present", () => {
    const md = renderSummary(
      makeRunData({
        crashes: [{ type: "java", marker: "FATAL EXCEPTION", rawLineNo: 42 }],
      }),
    );
    expect(md).toContain("**java**");
    expect(md).toContain("raw line 42");
    expect(md).toContain("FATAL EXCEPTION");
  });

  it("describes timeline events per type", () => {
    const md = renderSummary(
      makeRunData({
        events: [
          { type: "mark", ts: "T1", name: "before_login" },
          { type: "tap", ts: "T2", x: 100, y: 200, label: "Login" },
          { type: "input_text", ts: "T3", length: 8, redacted: true },
        ],
      }),
    );
    expect(md).toContain('mark "before_login"');
    expect(md).toContain("tap (100, 200) — Login");
    expect(md).toContain("input_text — 8 chars (redacted)");
  });

  it("describes a tap_node event with its source anchor", () => {
    const md = renderSummary(
      makeRunData({
        events: [
          {
            type: "tap_node",
            ts: "T4",
            x: 100,
            y: 200,
            anchorNode: { resourceId: "com.example.app:id/login" },
            label: "Login",
          },
        ],
      }),
    );
    expect(md).toContain("tap_node (100, 200) → com.example.app:id/login — Login");
  });

  it("caps the timeline and notes how many events were omitted", () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      type: "mark",
      ts: `T${i}`,
      name: `m${i}`,
    }));
    const md = renderSummary(makeRunData({ events }));
    expect(md).toContain("50 earlier events omitted");
    expect(md).toContain('mark "m249"'); // the most recent is kept
    expect(md).not.toContain('mark "m0"'); // the oldest is dropped
  });
});
