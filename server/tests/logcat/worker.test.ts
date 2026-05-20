import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessTracker } from "../../src/logcat/process_tracker.ts";
import { RawWriter } from "../../src/logcat/raw_writer.ts";
import { LogcatWorker } from "../../src/logcat/worker.ts";
import type { AppendStream } from "../../src/store/jsonl.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-worker-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A stub AppendStream whose append() can be made to reject. */
function stubStream(behavior: { fail?: boolean } = {}): {
  stream: AppendStream;
  appended: unknown[];
} {
  const appended: unknown[] = [];
  const stream = {
    append: async (record: unknown) => {
      if (behavior.fail) throw new Error("simulated derived append failure");
      appended.push(record);
    },
  } as unknown as AppendStream;
  return { stream, appended };
}

// A logcat line whose pid is in knownPids → shouldKeep === true → it reaches
// logcatStream.append (the derived channel we want to fail).
const KEPT_LINE = "05-20 10:15:49.820 10100  4567  4567 I MyApp   : kept line one\n";
const KEPT_LINE_2 = "05-20 10:15:49.900 10100  4567  4567 I MyApp   : kept line two\n";

describe("LogcatWorker — raw channel isolation (P4-P1-1)", () => {
  it("keeps byte-teeing to raw even when every derived append rejects", async () => {
    const rawWriter = await RawWriter.open(join(scratch, "logcat.raw.txt"));
    const logcat = stubStream({ fail: true });
    const crash = stubStream({ fail: true });
    const tracker = new ProcessTracker("DEV", "com.example.app", "10100", [4567]);
    const worker = new LogcatWorker({
      rawWriter,
      logcatStream: logcat.stream,
      crashStream: crash.stream,
      tracker,
      emitEvent: async () => undefined,
    });

    // Two chunks; the derived append rejects throughout.
    await worker.onChunk(Buffer.from(KEPT_LINE));
    await worker.onChunk(Buffer.from(KEPT_LINE_2));
    await worker.finish(); // must NOT reject despite derived failures
    await rawWriter.close();

    // The raw truth channel has BOTH lines, byte-for-byte.
    const raw = readFileSync(join(scratch, "logcat.raw.txt"), "utf8");
    expect(raw).toContain("kept line one");
    expect(raw).toContain("kept line two");
    // Derived failures were counted, not thrown.
    expect(worker.stats().derivedErrors).toBeGreaterThan(0);
    // The derived stream got nothing (every append rejected).
    expect(logcat.appended).toHaveLength(0);
  });

  it("a derived failure on an early chunk does not block raw for later chunks", async () => {
    const rawWriter = await RawWriter.open(join(scratch, "raw2.txt"));
    const tracker = new ProcessTracker("DEV", "com.example.app", "10100", [4567]);
    // logcat append fails only on the first call, succeeds after.
    let calls = 0;
    const flaky = {
      append: async (record: unknown) => {
        calls += 1;
        if (calls === 1) throw new Error("first derived append fails");
        (flaky as unknown as { ok: unknown[] }).ok ??= [];
        ((flaky as unknown as { ok: unknown[] }).ok as unknown[]).push(record);
      },
    } as unknown as AppendStream;
    const worker = new LogcatWorker({
      rawWriter,
      logcatStream: flaky,
      crashStream: stubStream().stream,
      tracker,
      emitEvent: async () => undefined,
    });

    await worker.onChunk(Buffer.from(KEPT_LINE));
    await worker.onChunk(Buffer.from("05-20 10:15:50.000 10100  4567  4567 I MyApp   : third\n"));
    await worker.finish();
    await rawWriter.close();

    const raw = readFileSync(join(scratch, "raw2.txt"), "utf8");
    expect(raw).toContain("kept line one");
    expect(raw).toContain("third");
  });

  it("writes kept entries to the derived stream on the happy path", async () => {
    const rawWriter = await RawWriter.open(join(scratch, "raw3.txt"));
    const logcat = stubStream();
    const tracker = new ProcessTracker("DEV", "com.example.app", "10100", [4567]);
    const worker = new LogcatWorker({
      rawWriter,
      logcatStream: logcat.stream,
      crashStream: stubStream().stream,
      tracker,
      emitEvent: async () => undefined,
    });
    await worker.onChunk(Buffer.from(KEPT_LINE + KEPT_LINE_2));
    await worker.finish();
    await rawWriter.close();
    expect(logcat.appended.length).toBe(2);
    expect(worker.stats().derivedErrors).toBe(0);
    expect(worker.stats().linesParsed).toBe(2);
  });

  it("rawByteCount locates each entry's own raw span, not the next entry's (P4-R2-P2)", async () => {
    const rawWriter = await RawWriter.open(join(scratch, "rawbc.txt"));
    const logcat = stubStream();
    const tracker = new ProcessTracker("DEV", "com.example.app", "10100", [4567]);
    const worker = new LogcatWorker({
      rawWriter,
      logcatStream: logcat.stream,
      crashStream: stubStream().stream,
      tracker,
      emitEvent: async () => undefined,
    });
    // Two kept entries in ONE chunk: entry 1 flushes only when entry 2's
    // header line arrives. Its rawByteCount must still point at the end of
    // entry 1, not after entry 2.
    await worker.onChunk(Buffer.from(KEPT_LINE + KEPT_LINE_2));
    await worker.finish();
    await rawWriter.close();

    const [first, second] = logcat.appended as Array<{ rawByteCount: number }>;
    expect(first?.rawByteCount).toBe(Buffer.byteLength(KEPT_LINE, "utf8"));
    expect(second?.rawByteCount).toBe(
      Buffer.byteLength(KEPT_LINE, "utf8") + Buffer.byteLength(KEPT_LINE_2, "utf8"),
    );
  });
});

describe("LogcatWorker — crash scan on the raw line", () => {
  it("records a crash signature even for a line the jsonl filter would drop", async () => {
    const rawWriter = await RawWriter.open(join(scratch, "raw4.txt"));
    const crash = stubStream();
    // Empty knownPids + foreign tag → the line is NOT kept in logcat.jsonl,
    // but the crash scan runs on the raw line regardless.
    const tracker = new ProcessTracker("DEV", "com.example.app", "10100", []);
    const worker = new LogcatWorker({
      rawWriter,
      logcatStream: stubStream().stream,
      crashStream: crash.stream,
      tracker,
      emitEvent: async () => undefined,
    });
    await worker.onChunk(
      Buffer.from("05-20 10:17:10.120 10999  9000  9000 E AndroidRuntime: FATAL EXCEPTION: main\n"),
    );
    await worker.finish();
    await rawWriter.close();
    expect(crash.appended).toHaveLength(1);
    expect((crash.appended[0] as { type: string }).type).toBe("java");
  });
});
