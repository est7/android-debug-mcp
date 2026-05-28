import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeViewport } from "../../src/adb/viewport.ts";
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
vi.mock("../../src/adb/viewport.ts", () => ({ probeViewport: vi.fn() }));
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

  // ──────────────────────── v2-F.3 filter / limit ────────────────────────
  // FAKE_UI_XML has 3 elements:
  //   1. text:"Login" contentDesc:"" bounds [0,0]-[400,100]    clickable
  //   2. text:"Cancel" contentDesc:"" bounds [0,200]-[50,250]   clickable
  //   3. text:"" contentDesc:"Search" bounds [100,500]-[900,1200] clickable

  it("v2-F.3: filter.textContains narrows annotation.elements", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { textContains: "login" },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: {
        elements: Array<{ resourceId: string; annotationId: number }>;
        elementCount: number;
        unfilteredCount: number;
        filteredCount: number;
        truncated?: true;
        error: string | null;
      };
    };
    expect(sc.annotation.error).toBeNull();
    expect(sc.annotation.unfilteredCount).toBe(3);
    expect(sc.annotation.filteredCount).toBe(1);
    expect(sc.annotation.elementCount).toBe(1);
    expect(sc.annotation.elements[0]?.resourceId).toBe("com.x:id/btn_login");
    expect(sc.annotation.elements[0]?.annotationId).toBe(1);
    expect(sc.annotation.truncated).toBeUndefined();
  });

  it("v2-F.3: filter.contentDescContains reaches icon-only elements (text='', contentDesc set)", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { contentDescContains: "search" },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: { elements: Array<{ resourceId: string }>; filteredCount: number };
    };
    expect(sc.annotation.filteredCount).toBe(1);
    expect(sc.annotation.elements[0]?.resourceId).toBe("com.x:id/search");
  });

  it("v2-F.3: limit truncates post-filter; annotation.truncated:true + filteredCount > elementCount", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { clickableOnly: true },
        limit: 2,
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: {
        elementCount: number;
        unfilteredCount: number;
        filteredCount: number;
        truncated?: true;
      };
    };
    expect(sc.annotation.unfilteredCount).toBe(3);
    expect(sc.annotation.filteredCount).toBe(3);
    expect(sc.annotation.elementCount).toBe(2);
    expect(sc.annotation.truncated).toBe(true);
  });

  it("v2-F.3: filter without annotateElements:true → query_malformed", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        filter: { textContains: "login" },
        // annotateElements omitted
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });

  it("v2-F.3: limit without annotateElements:true → query_malformed", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        limit: 5,
        // annotateElements omitted; filter omitted; only an explicit limit
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });

  it("v2-F.3 Round 3 regression: limit:100 (== default value) without annotateElements → query_malformed", async () => {
    // v0.5.2 audit blocker #3: when capture's `limit` had `.default(100)`,
    // the handler used `input.limit !== 100` as the explicit-limit check,
    // so caller-supplied `{limit:100}` slipped past the reject gate. The
    // v0.5.3 fix moves capture to a raw-optional schema; this regression
    // pins the contract.
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        limit: 100, // same as the previous default; MUST still reject
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });

  it("v2-F.3: omitting filter/limit on capture w/o annotateElements is still valid (v2-F.1 behavior unchanged)", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"] },
    });
    expect(r.isError).toBeFalsy();
    expect(structured(r).annotation).toBeUndefined();
  });

  it("v2-F.3: inViewport probes viewport; intersect drops fully-outside elements", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    // Narrow viewport so the third element (bottom 1200) falls outside.
    vi.mocked(probeViewport).mockResolvedValue({ w: 1080, h: 450 });
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { inViewport: true },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: { unfilteredCount: number; filteredCount: number; warnings?: string[] };
    };
    expect(sc.annotation.unfilteredCount).toBe(3);
    expect(sc.annotation.filteredCount).toBe(2);
    expect(sc.annotation.warnings).toBeUndefined();
  });

  it("v2-F.3 Round 3: capture commands.jsonl + events.jsonl rows carry annotate audit fields", async () => {
    // v0.5.2 audit blocker #2: the response carried filter/limit/counts on
    // the annotate path, but appendCommand + appendEvent did not persist
    // them. v0.5.3 fix adds the locked audit fields to both rows; this test
    // pins the persisted shape.
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { clickableOnly: true },
        limit: 2,
      },
    });
    expect(r.isError).toBeFalsy();

    const commands = readFileSync(join(h.runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const captureCmd = commands.find((c) => c.tool === "capture");
    expect(captureCmd).toBeDefined();
    expect(captureCmd?.annotated).toBe(true);
    expect(captureCmd?.unfilteredElementCount).toBe(3);
    expect(captureCmd?.filteredElementCount).toBe(3);
    expect(captureCmd?.limit).toBe(2);
    expect(captureCmd?.truncated).toBe(true);
    expect(captureCmd?.filter).toEqual({ clickableOnly: true });

    const events = readFileSync(join(h.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const captureEvt = events.find((e) => e.type === "capture" && e.annotated === true);
    expect(captureEvt).toBeDefined();
    expect(captureEvt?.unfilteredElementCount).toBe(3);
    expect(captureEvt?.filteredElementCount).toBe(3);
    expect(captureEvt?.limit).toBe(2);
    expect(captureEvt?.truncated).toBe(true);
    expect(captureEvt?.filter).toEqual({ clickableOnly: true });
  });

  it("v2-F.3 Round 3: capture audit fields absent on non-annotate path", async () => {
    // Negative: a plain screenshot capture (no annotate) should NOT carry
    // the v2-F.3 audit fields — they are annotate-specific.
    const h = await harness();
    open.push(() => h.shutdown());
    await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"] },
    });
    const commands = readFileSync(join(h.runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const captureCmd = commands.find((c) => c.tool === "capture");
    expect(captureCmd?.annotated).toBeUndefined();
    expect(captureCmd?.unfilteredElementCount).toBeUndefined();
    expect(captureCmd?.filteredElementCount).toBeUndefined();
    expect(captureCmd?.filter).toBeUndefined();
    expect(captureCmd?.limit).toBeUndefined();
    expect(captureCmd?.truncated).toBeUndefined();
  });

  // ─────────────── v2-F.2 annotationIds subset filter ───────────────

  it("v2-F.2: annotationIds picks a subset; annotationId stays trimmed-ordinal (not renumbered)", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    // FAKE_UI_XML has 3 elements at indices 1/2/3 post-truncate.
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        annotationIds: [1, 3],
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: {
        elementCount: number;
        elements: Array<{ annotationId: number; resourceId: string }>;
        unfilteredCount: number;
        filteredCount: number;
        subsetRequested?: number;
        subsetApplied?: number;
      };
    };
    expect(sc.annotation.elementCount).toBe(2);
    // F2-Q10: annotationId stays the trimmed ordinal, ascending order.
    expect(sc.annotation.elements.map((e) => e.annotationId)).toEqual([1, 3]);
    expect(sc.annotation.subsetRequested).toBe(2);
    expect(sc.annotation.subsetApplied).toBe(2);
  });

  it("v2-F.2: annotationIds dedup is silent; subsetRequested reflects pre-dedup length", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        annotationIds: [2, 2, 1, 2],
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: {
        elements: Array<{ annotationId: number }>;
        subsetRequested?: number;
        subsetApplied?: number;
      };
    };
    expect(sc.annotation.subsetRequested).toBe(4);
    expect(sc.annotation.subsetApplied).toBe(2);
    expect(sc.annotation.elements.map((e) => e.annotationId)).toEqual([1, 2]);
  });

  it("v2-F.2: annotationIds out-of-range → query_malformed with available count", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        annotationIds: [99],
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; message?: string };
    expect(err.error).toBe("query_malformed");
  });

  it("v2-F.2: annotationIds without annotateElements:true → query_malformed", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotationIds: [1, 2],
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });

  it("v2-F.2 v0.5.5 regression: annotationIds + ui_dump failure → subsetRequested reflects caller intent (not 0)", async () => {
    // v0.5.4 audit blocker #1: when collectCurrentElements fails AFTER the
    // caller supplied annotationIds, the soft-degrade `emptyAnnotation`
    // emitted `subsetRequested:0` (lying about caller intent). v0.5.5 fix:
    // helper takes the actual count + emits truthful pair.
    adbState.uiDumpResult = { ok: false, xml: null, detail: "mock-failed" };
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        annotationIds: [1, 2, 3],
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: {
        screenshotPath: string | null;
        error: string | null;
        elementCount: number;
        elements: unknown[];
        subsetRequested?: number;
        subsetApplied?: number;
      };
    };
    expect(sc.annotation.error).toBe("annotate_elements_unavailable");
    expect(sc.annotation.screenshotPath).toBeNull();
    expect(sc.annotation.elementCount).toBe(0);
    expect(sc.annotation.elements).toEqual([]);
    // The fix: subsetRequested reflects the caller-supplied length, NOT 0.
    expect(sc.annotation.subsetRequested).toBe(3);
    expect(sc.annotation.subsetApplied).toBe(0);
  });

  it("v2-F.2: subsetRequested / subsetApplied absent when annotationIds omitted", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: { subsetRequested?: unknown; subsetApplied?: unknown };
    };
    expect(sc.annotation.subsetRequested).toBeUndefined();
    expect(sc.annotation.subsetApplied).toBeUndefined();
  });

  it("v2-F.2: audit row carries annotationIds + subsetApplied when subset used", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        annotationIds: [2, 3],
      },
    });
    const commands = readFileSync(join(h.runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const cmd = commands.find((c) => c.tool === "capture" && c.annotated === true);
    expect(cmd?.annotationIds).toEqual([2, 3]);
    expect(cmd?.subsetApplied).toBe(2);
  });

  it("v2-F.2: audit row omits annotationIds/subsetApplied when no subset requested", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId: h.runId, kinds: ["screenshot"], annotateElements: true },
    });
    const commands = readFileSync(join(h.runDir, "commands.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const cmd = commands.find((c) => c.tool === "capture" && c.annotated === true);
    expect(cmd?.annotationIds).toBeUndefined();
    expect(cmd?.subsetApplied).toBeUndefined();
  });

  it("v2-F.3: viewport_unknown surfaces in annotation.warnings when wm size probe fails", async () => {
    const h = await harness();
    open.push(() => h.shutdown());
    vi.mocked(probeViewport).mockResolvedValue(null);
    const r = await h.client.callTool({
      name: "android_debug_capture",
      arguments: {
        runId: h.runId,
        kinds: ["screenshot"],
        annotateElements: true,
        filter: { inViewport: true },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r) as {
      annotation: { filteredCount: number; warnings?: string[] };
    };
    // inViewport no-op'd → every element passes the filter.
    expect(sc.annotation.filteredCount).toBe(3);
    expect(sc.annotation.warnings).toEqual(["viewport_unknown"]);
  });
});
