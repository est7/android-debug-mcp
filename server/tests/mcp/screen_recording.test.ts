import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerScreenRecording } from "../../src/mcp/tools/screen_recording.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

const recorder = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
  stops: [] as Array<Record<string, unknown>>,
  discards: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/adb/screenrecord.ts", () => ({
  startScreenRecording: async (input: Record<string, unknown>) => {
    recorder.starts.push(input);
    return { ...input, remotePid: 4321 };
  },
  stopScreenRecording: async (input: Record<string, unknown>) => {
    recorder.stops.push(input);
    const artifactPath = input.artifactPath as string;
    writeFileSync(artifactPath, Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]), {
      flag: "w",
    });
    const contactSheetPath = artifactPath.replace(/\.mp4$/, "-contact-sheet.png");
    return {
      stoppedAt: "2026-08-11T10:00:04.000Z",
      durationMs: 4_000,
      byteSize: 12,
      forced: false,
      contactSheet: {
        path: contactSheetPath,
        frameCount: 15,
        columns: 6,
        rows: 3,
        order: "left_to_right_top_to_bottom",
      },
      warnings: [],
    };
  },
  discardScreenRecording: async (input: Record<string, unknown>) => {
    recorder.discards.push(input);
  },
}));

vi.mock("../../src/adb/devices.ts", () => ({
  listDevices: async () => [
    { deviceSerial: "FAKEDEV0", state: "device", model: "fake", apiLevel: 33, abi: "arm64-v8a" },
  ],
}));

vi.mock("../../src/adb/app.ts", () => ({
  getCurrentUser: async () => 0,
  getPackageVersion: async () => ({ versionName: "1.0.0", versionCode: "100" }),
  getDeviceProps: async () => ({
    model: "fake",
    apiLevel: 33,
    abi: "arm64-v8a",
    buildFingerprint: "fp",
    timezone: "Asia/Shanghai",
  }),
  getAppPids: async () => [],
  getAppUid: async () => "10100",
  launchApp: async () => ({ launched: false, detail: "mock: not launched" }),
}));

vi.mock("../../src/logcat/channel.ts", () => ({
  LogcatChannel: {
    start: async () => ({
      currentState: "running",
      shutdown: async () => ({
        exitCode: 0,
        signalCode: null,
        killed: false,
        bytesRead: 0,
        linesParsed: 0,
        crashMarkers: 0,
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

interface Harness {
  readonly client: Client;
  readonly manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "screen-recording-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerScreenRecording(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push({
    shutdown: async () => {
      for (const session of manager.listActive()) {
        await manager.stop(session).catch(() => undefined);
      }
      await client.close();
      await server.close();
    },
  });
  return { client, manager };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-screen-recording-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  recorder.starts.length = 0;
  recorder.stops.length = 0;
  recorder.discards.length = 0;
});

afterEach(async () => {
  for (const item of open.splice(0)) await item.shutdown();
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function errorPayload(result: unknown): Record<string, unknown> {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

async function startRun(h: Harness): Promise<{ runId: string; runDir: string }> {
  const result = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.screenrecord" },
  });
  const sc = structured(result);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("android_debug_screen_recording", () => {
  it("does not record on session start and saves an explicitly started recording", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    expect(recorder.starts).toHaveLength(0);

    const start = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "start", maxDurationSeconds: 4, bitRate: 12_000_000 },
    });
    expect(start.isError).toBeFalsy();
    expect(recorder.starts).toHaveLength(1);
    expect(structured(start)).toMatchObject({
      runId,
      action: "start",
      status: "recording",
      maxDurationSeconds: 4,
      bitRate: 12_000_000,
    });
    const recordingId = structured(start).recordingId as string;

    const stop = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "stop", recordingId },
    });
    expect(stop.isError).toBeFalsy();
    expect(structured(stop)).toMatchObject({
      runId,
      recordingId,
      action: "stop",
      status: "saved",
      durationMs: 4_000,
      byteSize: 12,
    });
    expect(structured(stop).videoPath).toBe(
      join(runDir, "artifacts", `screenrecord-${recordingId}.mp4`),
    );
    expect(structured(stop).contactSheet).toEqual({
      path: join(runDir, "artifacts", `screenrecord-${recordingId}-contact-sheet.png`),
      frameCount: 15,
      columns: 6,
      rows: 3,
      order: "left_to_right_top_to_bottom",
    });

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"screen_recording_started"');
    expect(events).toContain('"type":"screen_recording_saved"');
    expect(events).toContain(`screenrecord-${recordingId}-contact-sheet.png`);
    const commands = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    expect(commands).toContain('"tool":"screen_recording"');
    expect(commands).toContain("screenrecord --bit-rate 12000000 --time-limit 4");
  });

  it("rejects a second start while one recording is active", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const first = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "start" },
    });
    expect(first.isError).toBeFalsy();

    const second = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "start" },
    });
    expect(second.isError).toBe(true);
    expect(errorPayload(second)).toMatchObject({ error: "screen_recording_active" });
    expect(recorder.starts).toHaveLength(1);
  });

  it("rejects stop when the recording id does not match the active recording", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "start" },
    });

    const stop = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "stop", recordingId: "000000000000" },
    });
    expect(stop.isError).toBe(true);
    expect(errorPayload(stop)).toMatchObject({ error: "screen_recording_not_active" });
    expect(recorder.stops).toHaveLength(0);
  });

  it("auto-stops an active recording when the session finalizes", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    const start = await h.client.callTool({
      name: "android_debug_screen_recording",
      arguments: { runId, action: "start", maxDurationSeconds: 4 },
    });
    expect(start.isError).toBeFalsy();

    const session = h.manager.require(runId);
    await h.manager.stop(session);
    expect(recorder.stops).toHaveLength(1);
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toContain(
      '"reason":"session_finalize"',
    );
  });
});
