import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePng } from "../../src/annotate/paint.ts";
import { registerCapture } from "../../src/mcp/tools/capture.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

// captureUiDump XML — three usable elements:
//   1. text "Login"        bounds 0,0..400,100      (top-of-screen big bbox → inside)
//   2. text "Cancel"        bounds 0,200..50,250    (small bbox → outside fallback)
//   3. contentDesc "Search"  bounds 100,500..900,1200
const FAKE_UI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="Login" resource-id="com.x:id/btn_login" class="android.widget.Button" package="com.x" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][400,100]" />
  <node index="1" text="Cancel" resource-id="com.x:id/btn_cancel" class="android.widget.Button" package="com.x" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,200][50,250]" />
  <node index="2" text="" resource-id="com.x:id/search" class="android.widget.EditText" package="com.x" content-desc="Search" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,500][900,1200]" />
</hierarchy>
`;

const EMPTY_UI_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy rotation="0"></hierarchy>\n`;

// Hoisted mutable state so tests can switch between scenarios at run time.
const adbState = vi.hoisted(() => ({
  uiDumpResult: { ok: true as boolean, xml: null as string | null, detail: "mock" },
  /** Reset per test. Bumped by every captureUiDump call so tests can assert no double-dump. */
  uiDumpCalls: 0,
}));

vi.mock("../../src/adb/capture.ts", () => ({
  // captureScreenshot writes a real PNG to disk — annotate decodes it back.
  // Use a 400×1200 canvas: matches the fake UI bounds enough that the painter
  // won't try to write off-canvas pixels.
  captureScreenshot: async (_serial: string, path: string) => {
    const png = new PNG({ width: 400, height: 1200 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 0x10;
      png.data[i + 1] = 0x10;
      png.data[i + 2] = 0x10;
      png.data[i + 3] = 0xff;
    }
    writeFileSync(path, PNG.sync.write(png));
  },
  captureUiDump: async (_serial: string, path: string) => {
    adbState.uiDumpCalls += 1;
    if (adbState.uiDumpResult.ok && adbState.uiDumpResult.xml !== null) {
      writeFileSync(path, adbState.uiDumpResult.xml);
    }
    return { ...adbState.uiDumpResult };
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
  }),
  getAppPids: async () => [],
  getAppUid: async () => "10100",
  launchApp: async () => ({ launched: false, detail: "mock" }),
  getForegroundActivity: async () => ({
    activity: "com.x/.Main",
    foreground: true,
  }),
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

async function harness(): Promise<{
  client: Client;
  runId: string;
  runDir: string;
  shutdown(): Promise<void>;
}> {
  const manager = new SessionManager();
  const server = new McpServer({ name: "capture-annotate-test", version: "0.0.0-test" });
  registerStartSession(server, manager);
  registerCapture(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const r = await client.callTool({
    name: "android_debug_start_session",
    arguments: { deviceSerial: "FAKEDEV0", packageName: "com.x", projectRoot: scratch },
  });
  const sc = (r as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  return {
    client,
    runId: sc.runId as string,
    runDir: sc.runDir as string,
    async shutdown() {
      for (const session of manager.listActive()) {
        await session.finalize("stopped");
      }
      await client.close();
      await server.close();
    },
  };
}

const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-annotate-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  adbState.uiDumpResult = { ok: true, xml: FAKE_UI_XML, detail: "mock" };
  adbState.uiDumpCalls = 0;
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

describe("capture annotateElements (v2-F.1)", () => {
  it("S1: with annotateElements:true returns an annotated PNG + element mapping; ids are 1..N matching elements order", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      captureId: string;
      screenshotPath: string;
      annotation: {
        screenshotPath: string | null;
        elementCount: number;
        error: string | null;
        elements: Array<{ annotationId: number; center: { x: number; y: number } }>;
      };
    };
    expect(sc.screenshotPath).toMatch(/screenshot-[0-9a-f]{12}\.png$/);
    expect(sc.annotation.error).toBeNull();
    expect(sc.annotation.screenshotPath).toMatch(/screenshot-[0-9a-f]{12}-annotated\.png$/);
    expect(sc.annotation.elementCount).toBe(3);
    expect(sc.annotation.elements).toHaveLength(3);
    expect(sc.annotation.elements.map((e) => e.annotationId)).toEqual([1, 2, 3]);
    // annotated PNG file actually exists + decodes + matches input dimensions
    const annotated = decodePng(readFileSync(sc.annotation.screenshotPath as string));
    expect(annotated.width).toBe(400);
    expect(annotated.height).toBe(1200);
  });

  it("S5: omitting annotateElements leaves the capture output byte-shape unchanged (no `annotation` field)", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"] },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.annotation).toBeUndefined();
    expect(sc.screenshotPath).toMatch(/screenshot-[0-9a-f]{12}\.png$/);
  });

  it("S4: annotateElements:true with kinds=['ui_dump'] only is rejected with query_malformed", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["ui_dump"], annotateElements: true },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });

  it("S2: empty UI hierarchy → annotation.elementCount:0 + annotated PNG BYTE-IDENTICAL to original (design lock § S2, codex post-impl audit #3)", async () => {
    adbState.uiDumpResult = { ok: true, xml: EMPTY_UI_XML, detail: "mock" };
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      screenshotPath: string;
      annotation: {
        error: string | null;
        elementCount: number;
        elements: unknown[];
        screenshotPath: string | null;
      };
    };
    expect(sc.annotation.error).toBeNull();
    expect(sc.annotation.elementCount).toBe(0);
    expect(sc.annotation.elements).toEqual([]);
    expect(sc.annotation.screenshotPath).not.toBeNull();
    // Byte-identical copy guarantee — no pngjs decode/re-encode for empty
    // element list (round-trip is not guaranteed to be byte-stable).
    const rawBytes = readFileSync(sc.screenshotPath);
    const annotatedBytes = readFileSync(sc.annotation.screenshotPath as string);
    expect(annotatedBytes.equals(rawBytes)).toBe(true);
  });

  it("S3: captureUiDump failure → soft-degrade annotation.error='annotate_elements_unavailable' + tool returns ok with raw screenshot intact", async () => {
    adbState.uiDumpResult = { ok: false, xml: null, detail: "mock-failed" };
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      screenshotPath: string;
      annotation: {
        screenshotPath: string | null;
        error: string | null;
        elementCount: number;
        elements: unknown[];
      };
    };
    // Raw screenshot untouched
    expect(sc.screenshotPath).toMatch(/screenshot-[0-9a-f]{12}\.png$/);
    // Annotation degraded
    expect(sc.annotation.screenshotPath).toBeNull();
    expect(sc.annotation.error).toBe("annotate_elements_unavailable");
    expect(sc.annotation.elementCount).toBe(0);
    expect(sc.annotation.elements).toEqual([]);
  });

  it("S8: annotation.elements[i].center is computable as floor((left+right)/2, (top+bottom)/2) of the same bounds (agent can drive tap_node without a second list_elements call)", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    const sc = structured(r) as {
      annotation: {
        elements: Array<{
          annotationId: number;
          bounds: { left: number; top: number; right: number; bottom: number };
          center: { x: number; y: number };
        }>;
      };
    };
    for (const el of sc.annotation.elements) {
      expect(el.center.x).toBe(Math.floor((el.bounds.left + el.bounds.right) / 2));
      expect(el.center.y).toBe(Math.floor((el.bounds.top + el.bounds.bottom) / 2));
    }
  });

  it("S10: capture+annotate twice on the same UI → identical center / bounds (recipe deterministic); annotationId determinism is collection-order side effect, NOT a binding contract", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const first = structured(
      await h.client.callTool({
        name: "android_debug_capture",
        arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
      }),
    ) as { annotation: { elements: Array<{ bounds: unknown; center: unknown }> } };
    const second = structured(
      await h.client.callTool({
        name: "android_debug_capture",
        arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
      }),
    ) as { annotation: { elements: Array<{ bounds: unknown; center: unknown }> } };
    expect(second.annotation.elements.map((e) => e.bounds)).toEqual(
      first.annotation.elements.map((e) => e.bounds),
    );
    expect(second.annotation.elements.map((e) => e.center)).toEqual(
      first.annotation.elements.map((e) => e.center),
    );
    // Intentionally NO assertion on annotationId equality across calls — the
    // contract is response-local, not cross-call identity (design lock § Q5).
  });

  it("kinds=['screenshot','ui_dump'] + annotateElements:true runs the UI dump EXACTLY ONCE (codex post-impl audit #2: single dump → uiSummary and annotation see the same xml)", async () => {
    // Reset counter (beforeEach does this too but be explicit).
    adbState.uiDumpCalls = 0;
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot", "ui_dump"],
        annotateElements: true,
      },
    });
    expect(r.isError).toBeFalsy();
    // Critical: ONE dump, not two. If the handler regresses to double-dump,
    // uiSummary could describe XML(t=T1) while the on-disk file is XML(t=T2)
    // and evidence integrity breaks.
    expect(adbState.uiDumpCalls).toBe(1);
    const sc = structured(r) as {
      uiDumpPath: string;
      uiSummary: { nodeCount: number };
      annotation: { elementCount: number };
    };
    expect(sc.uiDumpPath).toMatch(/ui-[0-9a-f]{12}\.xml$/);
    // Sanity: both paths consumed the same dump → annotate's element count
    // matches whatever uiSummary saw (3 clickable nodes in FAKE_UI_XML).
    expect(sc.annotation.elementCount).toBe(3);
    expect(sc.uiSummary.nodeCount).toBeGreaterThan(0);
  });
});
