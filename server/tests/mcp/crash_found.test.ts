import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerGetRunSummary } from "../../src/mcp/tools/get_run_summary.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerStopSession } from "../../src/mcp/tools/stop_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

// `logcatState.crashMarkers` is what the fake logcat channel reports from
// shutdown(); the tests drive it to exercise the finalize → metadata fold.
const logcatState = vi.hoisted(() => ({ crashMarkers: 0 }));

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
        crashMarkers: logcatState.crashMarkers,
        derivedErrors: 0,
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

let scratch = "";
const open: Array<() => Promise<void>> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "crash-found-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerGetRunSummary(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push(async () => {
    for (const s of manager.listActive()) await s.finalize("stopped").catch(() => undefined);
    await client.close();
    await server.close();
  });
  return { client, manager };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-crashfound-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  logcatState.crashMarkers = 0;
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function startThenStop(h: Harness): Promise<{ stop: unknown; runId: string }> {
  const ss = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.crashfound" },
  });
  const runId = structured(ss).runId as string;
  const stop = await h.client.callTool({
    name: "android_debug_stop_session",
    arguments: { runId },
  });
  return { stop, runId };
}

describe("crashFound — live session crash count folds into metadata at finalize", () => {
  it("a live run whose logcat reported crash markers finalizes crashFound:true", async () => {
    logcatState.crashMarkers = 2; // the fake logcat saw 2 FATAL markers
    const h = await harness();
    const { stop, runId } = await startThenStop(h);

    // stop_session's own structured response must report it.
    expect(structured(stop).crashFound).toBe(true);

    // ...and get_run_summary, which reads metadata.json from disk.
    const summary = await h.client.callTool({
      name: "android_debug_get_run_summary",
      arguments: { runId },
    });
    expect(structured(summary).crashFound).toBe(true);
  });

  it("a live run with no crash markers finalizes crashFound:false", async () => {
    logcatState.crashMarkers = 0;
    const h = await harness();
    const { stop, runId } = await startThenStop(h);
    expect(structured(stop).crashFound).toBe(false);

    const summary = await h.client.callTool({
      name: "android_debug_get_run_summary",
      arguments: { runId },
    });
    expect(structured(summary).crashFound).toBe(false);
  });
});
