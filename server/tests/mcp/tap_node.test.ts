import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureUiDump } from "../../src/adb/capture.ts";
import { inputTap } from "../../src/adb/input.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerTapNode } from "../../src/mcp/tools/tap_node.ts";
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
  getForegroundActivity: async () => ({ activity: "com.example.tapnode/.Main", foreground: true }),
}));
vi.mock("../../src/adb/capture.ts", () => ({ captureUiDump: vi.fn() }));
vi.mock("../../src/adb/input.ts", () => ({ inputTap: vi.fn(async () => undefined) }));
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

// One window, one Button leaf carrying an app-package resource-id.
const XML_WITH_ANCHOR =
  '<hierarchy><node class="android.widget.FrameLayout" package="com.example.tapnode" bounds="[0,0][1000,2000]">' +
  '<node class="android.widget.Button" package="com.example.tapnode" resource-id="com.example.tapnode:id/login" clickable="true" bounds="[100,100][300,200]" /></node></hierarchy>';
// Same shape, but the leaf has no resource-id.
const XML_NO_ANCHOR =
  '<hierarchy><node class="android.widget.FrameLayout" package="com.example.tapnode" bounds="[0,0][1000,2000]">' +
  '<node class="android.widget.TextView" package="com.example.tapnode" bounds="[100,100][300,200]" /></node></hierarchy>';

let scratch = "";
const open: Array<() => Promise<void>> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "tap-node-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerTapNode(server, manager);
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
  scratch = mkdtempSync(join(tmpdir(), "adm-tapnode-"));
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
    arguments: { packageName: "com.example.tapnode" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("android_debug_tap_node", () => {
  it("resolves a tap to its node and writes a self-sufficient tap_node event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: XML_WITH_ANCHOR, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_tap_node",
      arguments: { runId, x: 200, y: 150, label: "login button" },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect((sc.tappedNode as Record<string, unknown>).resourceId).toBe(
      "com.example.tapnode:id/login",
    );
    expect(sc.anchorSource).toBe("tapped_node");
    expect((sc.anchorNode as Record<string, unknown>).resourceId).toBe(
      "com.example.tapnode:id/login",
    );
    expect(sc.preTapForegroundActivity).toBe("com.example.tapnode/.Main");
    expect(sc.preTapCaptureId).toEqual(expect.any(String));
    expect(vi.mocked(inputTap)).toHaveBeenCalledWith("FAKEDEV0", 200, 150);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "tap_node")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "capture" &&
          Array.isArray(e.kinds) &&
          (e.kinds as string[]).includes("ui_dump"),
      ),
    ).toBe(true);
  });

  it("reports anchorSource none when the tapped node carries no app resource-id", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: XML_NO_ANCHOR, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_tap_node",
      arguments: { runId, x: 200, y: 150 },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.anchorNode).toBeNull();
    expect(sc.anchorSource).toBe("none");
    expect(vi.mocked(inputTap)).toHaveBeenCalledTimes(1);
  });

  it("fails with ui_dump_failed and does NOT tap when the pre-tap dump fails", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: false, xml: null, detail: "null root node" });

    const r = await h.client.callTool({
      name: "android_debug_tap_node",
      arguments: { runId, x: 200, y: 150 },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("ui_dump_failed");
    expect(vi.mocked(inputTap)).not.toHaveBeenCalled();
  });

  it("rejects a coordinate outside the captured UI and does NOT tap", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: XML_WITH_ANCHOR, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_tap_node",
      arguments: { runId, x: 5000, y: 5000 },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("invalid_argument");
    expect(vi.mocked(inputTap)).not.toHaveBeenCalled();
  });

  it("returns no_active_session for an unknown runId", async () => {
    const h = await harness();
    await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_tap_node",
      arguments: { runId: "no-such-run", x: 1, y: 1 },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("no_active_session");
  });
});
