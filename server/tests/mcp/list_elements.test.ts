import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureUiDump } from "../../src/adb/capture.ts";
import { registerListElements } from "../../src/mcp/tools/list_elements.ts";
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
  getForegroundActivity: async () => ({ activity: "com.example.elist/.Main", foreground: true }),
}));
vi.mock("../../src/adb/capture.ts", () => ({ captureUiDump: vi.fn() }));
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

// One window, one Button leaf so happy path has a non-empty element list.
const XML_ONE_BUTTON =
  '<hierarchy><node class="android.widget.FrameLayout" package="com.example.elist" bounds="[0,0][1000,2000]">' +
  '<node class="android.widget.Button" package="com.example.elist" resource-id="com.example.elist:id/ok" clickable="true" bounds="[100,100][300,200]" text="OK" /></node></hierarchy>';
// All useless containers — nothing in the filtered list.
const XML_EMPTY_USEFUL =
  '<hierarchy><node class="android.widget.FrameLayout" package="com.example.elist" bounds="[0,0][1000,2000]">' +
  '<node class="android.widget.LinearLayout" package="com.example.elist" bounds="[0,0][1000,2000]" /></node></hierarchy>';

let scratch = "";
const open: Array<() => Promise<void>> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "list-elements-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerListElements(server, manager);
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
  scratch = mkdtempSync(join(tmpdir(), "adm-elist-"));
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
    arguments: { packageName: "com.example.elist" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("android_debug_list_elements", () => {
  it("returns elements, writes capture + list_elements events, and records a command", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: XML_ONE_BUTTON, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId, label: "smoke" },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.windowCount).toBe(1);
    expect(sc.elementCount).toBe(1);
    expect(sc.captureId).toEqual(expect.any(String));
    const elements = sc.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0]?.resourceId).toBe("com.example.elist:id/ok");
    expect(elements[0]?.center).toEqual({ x: 200, y: 150 });

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.some((e) => e.type === "list_elements" && e.elementCount === 1)).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "capture" &&
          Array.isArray(e.kinds) &&
          (e.kinds as string[]).includes("ui_dump"),
      ),
    ).toBe(true);

    const commands = readFileSync(join(runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(
      commands.some(
        (c) =>
          c.tool === "list_elements" &&
          Array.isArray(c.kinds) &&
          (c.kinds as string[]).includes("ui_dump"),
      ),
    ).toBe(true);
  });

  it("persists only counts in the `list_elements` event (elements array stays response-only)", async () => {
    // Design lock § list_elements 事件: element 列表只在 tool response 里返回,
    // 不持久化进 events.jsonl —— 原始 XML 已经落 artifacts/ 了。把这个契约钉住,
    // 防止未来误把 elements / 运行时 text 写进事件。
    const SECRET_TEXT = "EVENT_PRIVACY_X9Q_text";
    const SECRET_HINT = "EVENT_PRIVACY_X9Q_hint";
    const xmlWithBait = `<hierarchy><node class="android.widget.FrameLayout" package="com.example.elist" bounds="[0,0][1000,2000]"><node class="android.widget.EditText" package="com.example.elist" resource-id="com.example.elist:id/q" clickable="true" focusable="true" bounds="[100,100][300,200]" text="${SECRET_TEXT}" hint="${SECRET_HINT}" /></node></hierarchy>`;

    const h = await harness();
    const { runId, runDir } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: xmlWithBait, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId },
    });
    expect(r.isError).toBeFalsy();
    // Tool response DOES carry the runtime text — that's its purpose.
    expect(JSON.stringify(structured(r))).toContain(SECRET_TEXT);

    const eventsRaw = readFileSync(join(runDir, "events.jsonl"), "utf8");
    const listEvents = eventsRaw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "list_elements");
    expect(listEvents).toHaveLength(1);
    expect(listEvents[0]).not.toHaveProperty("elements");
    // Magic literals from the XML payload must not leak into ANY persisted event line.
    expect(eventsRaw).not.toContain(SECRET_TEXT);
    expect(eventsRaw).not.toContain(SECRET_HINT);
  });

  it("soft-returns elementCount=0 for a screen where every node is filtered out", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: true, xml: XML_EMPTY_USEFUL, detail: "ok" });

    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.elementCount).toBe(0);
    expect(sc.windowCount).toBe(1);
    expect(sc.elements).toEqual([]);
  });

  it("fails with ui_dump_failed when the uiautomator dump fails", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({ ok: false, xml: null, detail: "null root node" });

    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("ui_dump_failed");
  });

  it("fails with ui_dump_failed when the dumped XML is unparseable", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    vi.mocked(captureUiDump).mockResolvedValue({
      ok: true,
      xml: '<hierarchy><node class="X" package="p"></hierarchy>',
      detail: "ok",
    });

    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId },
    });

    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("ui_dump_failed");
  });

  it("returns no_active_session for an unknown runId", async () => {
    const h = await harness();
    await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_list_elements",
      arguments: { runId: "no-such-run" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("no_active_session");
  });
});
