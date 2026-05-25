import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdbExecError } from "../../src/adb/errors.ts";
import { inputSwipe } from "../../src/adb/input.ts";
import { registerLongPress } from "../../src/mcp/tools/long_press.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

vi.mock("../../src/adb/devices.ts", () => ({
  listDevices: async () => [
    { deviceSerial: "FAKEDEV0", state: "device", model: "fake", apiLevel: 33, abi: "arm64-v8a" },
  ],
}));
vi.mock("../../src/adb/app.ts", () => ({
  getCurrentUser: async () => 0,
  getPackageVersion: async () => ({ versionName: "9.9.9", versionCode: "999" }),
  getDeviceProps: async () => ({
    model: "fake",
    apiLevel: 33,
    abi: "arm64-v8a",
    buildFingerprint: "fp",
  }),
  getAppPids: async () => [],
  getAppUid: async () => "10100",
  launchApp: async () => ({ launched: false, detail: "mock" }),
  getForegroundActivity: async () => ({ activity: "com.example.lp/.Main", foreground: true }),
}));
vi.mock("../../src/adb/input.ts", () => ({ inputSwipe: vi.fn(async () => undefined) }));
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
const open: Array<() => Promise<void>> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "long-press-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerLongPress(server, manager);
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
  scratch = mkdtempSync(join(tmpdir(), "adm-longpress-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
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
    arguments: { packageName: "com.example.lp" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("android_debug_long_press", () => {
  it("issues a zero-displacement swipe and records the long_press event + command", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId, x: 540, y: 1200, durationMs: 1200, label: "avatar context" },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.ts).toEqual(expect.any(String));
    // zero-displacement swipe with the supplied duration
    expect(vi.mocked(inputSwipe)).toHaveBeenCalledWith(
      "FAKEDEV0",
      { x: 540, y: 1200 },
      { x: 540, y: 1200 },
      1200,
    );

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e.type === "long_press")).toMatchObject({
      type: "long_press",
      x: 540,
      y: 1200,
      durationMs: 1200,
      label: "avatar context",
    });

    const commands = readFileSync(join(runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(commands.find((c) => c.tool === "long_press")).toMatchObject({
      adb: "input swipe 540 1200 540 1200 1200",
    });
  });

  it("applies the default durationMs=500 when the caller omits it", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId, x: 100, y: 100 },
    });
    expect(r.isError).toBeFalsy();
    expect(vi.mocked(inputSwipe)).toHaveBeenCalledWith(
      "FAKEDEV0",
      { x: 100, y: 100 },
      { x: 100, y: 100 },
      500,
    );

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.find((e) => e.type === "long_press")).toMatchObject({
      type: "long_press",
      durationMs: 500,
    });
  });

  it("rejects durationMs=0 at zod validation (not in the typed catalog)", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId, x: 1, y: 1, durationMs: 0 },
    });
    // zod range rejection happens before the handler — the SDK returns
    // {isError:true, content:[text]} without going through ToolDomainError.
    expect(r.isError).toBe(true);
    expect(callText(r)).toContain("durationMs");
    expect(vi.mocked(inputSwipe)).not.toHaveBeenCalled();
  });

  it("rejects durationMs=50000 at zod validation", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId, x: 1, y: 1, durationMs: 50_000 },
    });
    expect(r.isError).toBe(true);
    expect(callText(r)).toContain("durationMs");
    expect(vi.mocked(inputSwipe)).not.toHaveBeenCalled();
  });

  it("surfaces adb failures as adb_command_failed and writes no long_press event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    vi.mocked(inputSwipe).mockRejectedValueOnce(
      new AdbExecError(["shell", "input", "swipe"], 1, "", "swipe failed"),
    );
    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId, x: 1, y: 1, durationMs: 500 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("adb_command_failed");

    const raw = readFileSync(join(runDir, "events.jsonl"), "utf8").trim();
    const events =
      raw === "" ? [] : raw.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "long_press")).toBe(false);
  });

  it("returns no_active_session for an unknown runId", async () => {
    const h = await harness();
    await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_long_press",
      arguments: { runId: "no-such-run", x: 1, y: 1 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("no_active_session");
  });
});
