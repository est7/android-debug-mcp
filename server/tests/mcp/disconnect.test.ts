import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, DeviceState } from "../../src/adb/devices.ts";
import { registerGetRunSummary } from "../../src/mcp/tools/get_run_summary.ts";
import { registerSearchLogs } from "../../src/mcp/tools/search_logs.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerStopSession } from "../../src/mcp/tools/stop_session.ts";
import { registerTap } from "../../src/mcp/tools/tap.ts";
import { HealthMonitor } from "../../src/session/health.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

vi.mock("../../src/adb/input.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/adb/input.ts")>()),
  inputTap: async () => undefined,
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
  }),
  getAppPids: async () => [],
  getAppUid: async () => "10100",
  launchApp: async () => ({ launched: false, detail: "mock" }),
  getForegroundActivity: async () => ({ activity: "com.example/.Main", foreground: true }),
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
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

/** A DeviceInfo for FAKEDEV0 in the given adb state. */
function fakeDevice(state: DeviceState): DeviceInfo {
  return { deviceSerial: "FAKEDEV0", state, model: "fake", apiLevel: 33, abi: "arm64-v8a" };
}

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "disconnect-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerTap(server, manager);
  registerSearchLogs(server, manager);
  registerGetRunSummary(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push({
    shutdown: async () => {
      for (const s of manager.listActive()) await s.finalize("stopped").catch(() => undefined);
      await client.close();
      await server.close();
    },
  });
  return { client, manager };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-disconnect-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.shutdown();
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}

async function startSession(h: Harness): Promise<{ runId: string; runDir: string }> {
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.disconnect" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("HealthMonitor.checkOnce", () => {
  it("degrades a session whose device is no longer in adb's `device` state", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const monitor = new HealthMonitor(h.manager, {
      listDevices: async () => [fakeDevice("offline")],
    });

    await monitor.checkOnce();

    expect(h.manager.require(runId).currentStatus).toBe("degraded");
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"device_disconnected"');
    expect(events).toContain("FAKEDEV0");
  });

  it("leaves a session active while its device is still connected", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    const monitor = new HealthMonitor(h.manager, {
      listDevices: async () => [fakeDevice("device")],
    });

    await monitor.checkOnce();

    expect(h.manager.require(runId).currentStatus).toBe("active");
  });

  it("skips the tick (no degrade) when the adb enumeration itself fails", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    const monitor = new HealthMonitor(h.manager, {
      listDevices: async () => {
        throw new Error("adb unreachable");
      },
    });

    await monitor.checkOnce();

    expect(h.manager.require(runId).currentStatus).toBe("active");
  });
});

describe("degraded session — tool gating", () => {
  it("a device-touching tool rejects with device_disconnected", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    await new HealthMonitor(h.manager, { listDevices: async () => [] }).checkOnce();

    const r = await h.client.callTool({
      name: "android_debug_tap",
      arguments: { runId, x: 10, y: 20 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("device_disconnected");
  });

  it("a record-reading tool still works on a degraded session", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    await new HealthMonitor(h.manager, { listDevices: async () => [] }).checkOnce();

    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      // v0.4.0 Block A: any narrowing filter satisfies the "no fetch-all" gate;
      // we just need a tool that can succeed on a degraded session.
      arguments: { runId, level: "I" },
    });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(structured(r).entries)).toBe(true);
  });

  it("a degraded session finalizes `degraded` — in stop_session's own response and the summary", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    await new HealthMonitor(h.manager, { listDevices: async () => [] }).checkOnce();

    // stop_session must report the run's ACTUAL terminal status, not flatten
    // a degraded run to `stopped`.
    const stop = await h.client.callTool({
      name: "android_debug_stop_session",
      arguments: { runId },
    });
    expect(structured(stop).status).toBe("degraded");

    const summary = await h.client.callTool({
      name: "android_debug_get_run_summary",
      arguments: { runId },
    });
    expect(structured(summary).status).toBe("degraded");
  });
});
