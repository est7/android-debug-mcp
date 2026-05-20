import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogcatChannel, type LogcatChannelInput } from "../../src/logcat/channel.ts";
import { ProcessTracker } from "../../src/logcat/process_tracker.ts";
import { RawWriter } from "../../src/logcat/raw_writer.ts";
import type { LogcatBufferInfo } from "../../src/logcat/spawn.ts";
import { AppendStream } from "../../src/store/jsonl.ts";

const { mockStartLogcat } = vi.hoisted(() => ({ mockStartLogcat: vi.fn() }));

vi.mock("../../src/logcat/spawn.ts", () => ({
  startLogcat: mockStartLogcat,
  DEFAULT_LOGCAT_BUFFER_SIZE: "16M",
  LOGCAT_BUFFERS: ["main", "system", "crash"],
}));
vi.mock("../../src/adb/app.ts", () => ({
  getAppUid: async () => "10100",
  getAppPids: async () => [],
}));

/** Minimal stand-in for the `adb logcat` ChildProcess. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    if (signal === "SIGKILL") this.signalCode = "SIGKILL";
    return true;
  }
}

const BUFFER_INFO: LogcatBufferInfo = {
  requested: "16M",
  effective: "16 MiB",
  buffers: ["main", "system", "crash"],
  error: null,
};

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-channel-"));
  mockStartLogcat.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 5));

async function channelInput(): Promise<LogcatChannelInput> {
  const logcatStream = await AppendStream.open(join(scratch, "logcat.jsonl"));
  const crashStream = await AppendStream.open(join(scratch, "crash.jsonl"));
  return {
    deviceSerial: "DEV",
    packageName: "com.example.app",
    userId: 0,
    runDir: scratch,
    startedAt: new Date("2026-05-20T10:00:00.000Z"),
    requestedBufferSize: "16M",
    logcatStream,
    crashStream,
    emitEvent: async () => undefined,
    seedPids: [],
  };
}

describe("LogcatChannel — shutdown waits for child `close` (P4-P1-2)", () => {
  it("does not finish draining until `close` fires, even after `exit`", async () => {
    const child = new FakeChild();
    mockStartLogcat.mockResolvedValue({ child, bufferInfo: BUFFER_INFO });
    const channel = await LogcatChannel.start(await channelInput());

    const shutdownPromise = channel.shutdown();
    let settled = false;
    void shutdownPromise.then(() => {
      settled = true;
    });

    // The child `exit`s, but stdout is NOT closed yet — and a late chunk
    // still arrives. Shutdown must keep waiting.
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.stdout.emit(
      "data",
      Buffer.from("05-20 10:00:01.000 10100  4567  4567 I MyApp   : late line\n"),
    );
    await tick();
    expect(settled).toBe(false);

    // `close` = stdio fully drained → shutdown may now finish.
    child.emit("close", 0, null);
    await shutdownPromise;
    expect(settled).toBe(true);

    // The late chunk reached the raw truth channel.
    expect(readFileSync(join(scratch, "logcat.raw.txt"), "utf8")).toContain("late line");
  });
});

describe("LogcatChannel.start — partial-failure cleanup (P4-P1-3)", () => {
  it("stops the pid tracker when startLogcat throws", async () => {
    mockStartLogcat.mockRejectedValue(new Error("spawn failed"));
    const stopSpy = vi.spyOn(ProcessTracker.prototype, "stop");
    await expect(LogcatChannel.start(await channelInput())).rejects.toThrow("spawn failed");
    expect(stopSpy).toHaveBeenCalled();
  });

  it("kills the spawned child when RawWriter.open fails afterwards", async () => {
    const child = new FakeChild();
    mockStartLogcat.mockResolvedValue({ child, bufferInfo: BUFFER_INFO });
    vi.spyOn(RawWriter, "open").mockRejectedValueOnce(new Error("raw open failed"));
    await expect(LogcatChannel.start(await channelInput())).rejects.toThrow("raw open failed");
    expect(child.killed).toBe(true);
  });
});

describe("LogcatChannel — clean shutdown", () => {
  it("SIGTERMs the child and reports stats", async () => {
    const child = new FakeChild();
    mockStartLogcat.mockResolvedValue({ child, bufferInfo: BUFFER_INFO });
    const channel = await LogcatChannel.start(await channelInput());

    const shutdownPromise = channel.shutdown();
    await tick();
    expect(child.killed).toBe(true); // SIGTERM sent
    child.emit("close", 0, null);
    const info = await shutdownPromise;
    expect(info.killed).toBe(false); // SIGKILL fallback not needed
    expect(info.bufferInfo.requested).toBe("16M");
    expect(channel.currentState).toBe("stopped");
  });
});
