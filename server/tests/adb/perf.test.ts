import { describe, expect, it } from "vitest";
import { parseGfxInfo, parseMemInfo } from "../../src/adb/perf.ts";

describe("parseGfxInfo", () => {
  it("parses frame counters and percentile digest", () => {
    const parsed = parseGfxInfo(`
Applications Graphics Acceleration Info:
Stats since: 123456789ns
Total frames rendered: 1,200
Janky frames: 60 (5.00%)
50th percentile: 8ms
90th percentile: 14ms
95th percentile: 18ms
99th percentile: 33ms
`);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.digest).toEqual({
      totalFrames: 1200,
      jankyFrames: 60,
      jankyPercent: 5,
      percentilesMs: { p50: 8, p90: 14, p95: 18, p99: 33 },
    });
  });

  it("keeps missing gfxinfo counters nullable and emits a warning", () => {
    const parsed = parseGfxInfo("Profile data in ms:\nDraw Prepare Process Execute\n");

    expect(parsed.digest).toEqual({
      totalFrames: null,
      jankyFrames: null,
      jankyPercent: null,
      percentilesMs: {},
    });
    expect(parsed.warnings).toEqual(["gfxinfo output did not contain recognized frame counters"]);
  });
});

describe("parseMemInfo", () => {
  it("parses PSS buckets from a dumpsys meminfo table", () => {
    const parsed = parseMemInfo(`
Applications Memory Usage (in Kilobytes):
** MEMINFO in pid 1234 [com.example.app] **
                   Pss  Private  Private  SwapPss
                 Total    Dirty    Clean    Dirty
  Native Heap    12,345   12,000        0        0
  Dalvik Heap     6,789    6,000        0        0
        Stack       234      200        0        0
     Graphics       456      456        0        0
         Code       789      789        0        0
        TOTAL    20,613   19,445        0        0
`);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.digest).toEqual({
      totalPssKb: 20613,
      nativeHeapKb: 12345,
      dalvikHeapKb: 6789,
      graphicsKb: 456,
      stackKb: 234,
      codeKb: 789,
    });
  });

  it("parses Graphics/Code from the colon-labeled App Summary (real device format)", () => {
    const parsed = parseMemInfo(`
Applications Memory Usage (in Kilobytes):
** MEMINFO in pid 1234 [com.example.app] **
                   Pss  Private  Private  SwapPss
                 Total    Dirty    Clean    Dirty
  Native Heap    35,436   35,000        0        0
  Dalvik Heap     5,000    5,000        0        0
        Stack     3,528    3,500        0        0
 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:    39908                          50240
         Native Heap:    35436                          36216
                Code:   210192                         305364
               Stack:     3528                           3540
            Graphics:      424                            424
           TOTAL PSS:   324004            TOTAL RSS:   417328
`);

    // Graphics + Code appear only in the colon-labeled App Summary — the regression.
    expect(parsed.digest.graphicsKb).toBe(424);
    expect(parsed.digest.codeKb).toBe(210192);
    // Table-sourced rows still resolve; TOTAL PSS from the colon line.
    expect(parsed.digest.nativeHeapKb).toBe(35436);
    expect(parsed.digest.dalvikHeapKb).toBe(5000);
    expect(parsed.digest.totalPssKb).toBe(324004);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses OEM TOTAL PSS colon output", () => {
    const parsed = parseMemInfo("TOTAL PSS: 42,001\n");

    expect(parsed.digest.totalPssKb).toBe(42001);
    expect(parsed.warnings).toEqual([]);
  });

  it("keeps missing meminfo rows nullable and emits a warning", () => {
    const parsed = parseMemInfo("No process found for: com.example.missing\n");

    expect(parsed.digest).toEqual({
      totalPssKb: null,
      nativeHeapKb: null,
      dalvikHeapKb: null,
      graphicsKb: null,
      stackKb: null,
      codeKb: null,
    });
    expect(parsed.warnings).toEqual(["meminfo output did not contain recognized PSS rows"]);
  });
});
