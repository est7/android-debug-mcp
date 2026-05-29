import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPerfSnapshot } from "../../src/mcp/tools/perf_snapshot.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

const perfCalls = vi.hoisted(() => ({
  gfxinfo: 0,
  meminfo: 0,
  reset: 0,
}));

vi.mock("../../src/adb/perf.ts", () => ({
  collectGfxInfo: async () => {
    perfCalls.gfxinfo++;
    return {
      digest: {
        totalFrames: 120,
        jankyFrames: 6,
        jankyPercent: 5,
        percentilesMs: { p50: 8, p90: 14, p95: 18, p99: 33 },
      },
      warnings: [],
      raw: "raw gfxinfo",
    };
  },
  collectMemInfo: async () => {
    perfCalls.meminfo++;
    return {
      digest: {
        totalPssKb: 2048,
        nativeHeapKb: 512,
        dalvikHeapKb: 768,
        graphicsKb: 128,
        stackKb: 64,
        codeKb: 256,
      },
      warnings: [],
      raw: "raw meminfo",
    };
  },
  resetGfxInfo: async () => {
    perfCalls.reset++;
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
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "perf-snapshot-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerPerfSnapshot(server, manager);
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
  scratch = mkdtempSync(join(tmpdir(), "adm-perf-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  perfCalls.gfxinfo = 0;
  perfCalls.meminfo = 0;
  perfCalls.reset = 0;
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

async function startRun(h: Harness): Promise<{ runId: string; runDir: string }> {
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.perf" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("android_debug_perf_snapshot", () => {
  it("returns gfxinfo and meminfo digest by default without raw dumpsys text", async () => {
    const h = await harness();
    const { runId } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_perf_snapshot",
      arguments: { runId },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.packageName).toBe("com.example.perf");
    expect(sc.reset).toBe(false);
    expect(sc.gfxinfo).toEqual({
      totalFrames: 120,
      jankyFrames: 6,
      jankyPercent: 5,
      percentilesMs: { p50: 8, p90: 14, p95: 18, p99: 33 },
    });
    expect(sc.meminfo).toEqual({
      totalPssKb: 2048,
      nativeHeapKb: 512,
      dalvikHeapKb: 768,
      graphicsKb: 128,
      stackKb: 64,
      codeKb: 256,
    });
    expect(JSON.stringify(sc)).not.toContain("raw gfxinfo");
    expect(perfCalls).toMatchObject({ gfxinfo: 1, meminfo: 1, reset: 0 });
  });

  it("honors kinds and raw:true", async () => {
    const h = await harness();
    const { runId } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_perf_snapshot",
      arguments: { runId, kinds: ["gfxinfo"], raw: true },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.gfxinfo).toMatchObject({ raw: "raw gfxinfo" });
    expect(sc.meminfo).toBeUndefined();
    expect(perfCalls).toMatchObject({ gfxinfo: 1, meminfo: 0, reset: 0 });
  });

  it("resets gfxinfo after collecting when reset:true", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_perf_snapshot",
      arguments: { runId, kinds: ["gfxinfo"], reset: true },
    });

    expect(r.isError).toBeFalsy();
    expect(structured(r).reset).toBe(true);
    expect(perfCalls).toMatchObject({ gfxinfo: 1, meminfo: 0, reset: 1 });
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"perf_snapshot"');
    expect(events).toContain('"reset":true');
    const commands = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    expect(commands).toContain("dumpsys gfxinfo com.example.perf reset");
  });

  it("rejects duplicate kinds", async () => {
    const h = await harness();
    const { runId } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_perf_snapshot",
      arguments: { runId, kinds: ["gfxinfo", "gfxinfo"] },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r))).toMatchObject({ error: "query_malformed" });
  });

  it("rejects reset without gfxinfo", async () => {
    const h = await harness();
    const { runId } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_perf_snapshot",
      arguments: { runId, kinds: ["meminfo"], reset: true },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r))).toMatchObject({ error: "query_malformed" });
    expect(perfCalls).toMatchObject({ gfxinfo: 0, meminfo: 0, reset: 0 });
  });
});
