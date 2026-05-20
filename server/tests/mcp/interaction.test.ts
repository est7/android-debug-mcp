import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADB_KEYBOARD_IME } from "../../src/adb/input.ts";
import { registerCapture } from "../../src/mcp/tools/capture.ts";
import { registerInputText } from "../../src/mcp/tools/input_text.ts";
import { registerSendKey } from "../../src/mcp/tools/send_key.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerSwipe } from "../../src/mcp/tools/swipe.ts";
import { registerTap } from "../../src/mcp/tools/tap.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

// vitest runs under Node; the adb / logcat layers shell out via APIs that need
// a real device. Mock them so the interaction tests are hermetic — the adb
// wrappers are covered by their own tests + the Phase 6 real-device probe.
// `encodeInputB64` is kept REAL so the recorded command literal is exercised
// exactly as in production.
//
// `imeState` is a hoisted handle the input_text tests drive: `current` is what
// `getDefaultIme` reports, `selectResult` is what `selectIme` leaves behind —
// set them unequal to simulate ADBKeyBoard failing to take the IME slot.
const imeState = vi.hoisted(() => ({
  current: "com.android.adbkeyboard/.AdbIME",
  selectResult: "com.android.adbkeyboard/.AdbIME",
}));
vi.mock("../../src/adb/input.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/adb/input.ts")>()),
  inputTap: async () => undefined,
  inputText: async () => undefined,
  inputKeyevent: async () => undefined,
  inputSwipe: async () => undefined,
  getDefaultIme: async () => imeState.current,
  selectIme: async () => {
    imeState.current = imeState.selectResult;
  },
}));
vi.mock("../../src/adb/capture.ts", () => ({
  captureScreenshot: async () => undefined,
  captureUiDump: async () => ({
    ok: true,
    xml: '<hierarchy><node clickable="true" /><node clickable="false" /><node clickable="true" /></hierarchy>',
    detail: "mock",
  }),
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
  launchApp: async () => ({ launched: false, detail: "mock: not launched" }),
  getForegroundActivity: async () => ({
    activity: "com.example.app/.MainActivity",
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

interface Harness {
  client: Client;
  manager: SessionManager;
}

interface OpenHarness extends Harness {
  shutdown(): Promise<void>;
}

const openHarnesses: OpenHarness[] = [];

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "interaction-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerTap(server, manager);
  registerInputText(server, manager);
  registerSendKey(server, manager);
  registerSwipe(server, manager);
  registerCapture(server, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const entry: OpenHarness = {
    client,
    manager,
    shutdown: async () => {
      for (const session of manager.listActive()) {
        await session.finalize("stopped").catch(() => undefined);
      }
      await client.close();
      await server.close();
    },
  };
  openHarnesses.push(entry);
  return entry;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-interaction-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  // Default: ADBKeyBoard is already the active IME — no switch needed.
  imeState.current = ADB_KEYBOARD_IME;
  imeState.selectResult = ADB_KEYBOARD_IME;
});

afterEach(async () => {
  for (const h of openHarnesses.splice(0)) {
    await h.shutdown();
  }
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

interface StartedSession {
  runId: string;
  runDir: string;
}

async function startSession(h: Harness): Promise<StartedSession> {
  const result = await h.client.callTool({
    name: "android_debug_start_session",
    // A package distinct from other test files': the session lock is global
    // (~/.android-debug-mcp/locks/), so a shared tuple would collide when
    // vitest runs test files in parallel.
    arguments: { packageName: "com.example.interaction" },
  });
  expect(result.isError).toBeFalsy();
  const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}

/** Raw file content of a run-folder jsonl stream. */
function readStream(runDir: string, name: "events" | "commands"): string {
  return readFileSync(join(runDir, `${name}.jsonl`), "utf8");
}

/** Parsed records of a run-folder jsonl stream. */
function readRecords(runDir: string, name: "events" | "commands"): Record<string, unknown>[] {
  return readStream(runDir, name)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("tap", () => {
  it("taps a coordinate and records one event + one command", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_tap",
      arguments: { runId, x: 540, y: 1200, label: "Login button" },
    });
    expect(result.isError).toBeFalsy();
    expect(typeof structured(result).ts).toBe("string");

    const events = readRecords(runDir, "events");
    const tap = events.find((e) => e.type === "tap");
    expect(tap).toMatchObject({ type: "tap", x: 540, y: 1200, label: "Login button" });

    const commands = readRecords(runDir, "commands");
    expect(commands.find((c) => c.tool === "tap")).toMatchObject({
      tool: "tap",
      adb: "input tap 540 1200",
    });
  });
});

describe("send_key", () => {
  it("sends a whitelisted key and records the KEYCODE literal", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_send_key",
      arguments: { runId, key: "BACK" },
    });
    expect(result.isError).toBeFalsy();

    expect(readRecords(runDir, "events").find((e) => e.type === "send_key")).toMatchObject({
      type: "send_key",
      key: "BACK",
    });
    expect(readRecords(runDir, "commands").find((c) => c.tool === "send_key")).toMatchObject({
      adb: "input keyevent KEYCODE_BACK",
    });
  });

  it("rejects a key outside the whitelist (POWER) at schema validation", async () => {
    const h = await harness();
    const { runId } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_send_key",
      arguments: { runId, key: "POWER" },
    });
    // The Zod enum IS the whitelist: an out-of-set key never reaches the
    // handler — the SDK rejects it at input validation and returns isError.
    expect(result.isError).toBe(true);
    expect(callText(result)).toContain("POWER");
  });
});

describe("swipe", () => {
  it("swipes between two points with a duration", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_swipe",
      arguments: { runId, x1: 100, y1: 200, x2: 300, y2: 400, durationMs: 250 },
    });
    expect(result.isError).toBeFalsy();

    expect(readRecords(runDir, "events").find((e) => e.type === "swipe")).toMatchObject({
      type: "swipe",
      x1: 100,
      y1: 200,
      x2: 300,
      y2: 400,
      durationMs: 250,
    });
    expect(readRecords(runDir, "commands").find((c) => c.tool === "swipe")).toMatchObject({
      adb: "input swipe 100 200 300 400 250",
    });
  });
});

describe("input_text", () => {
  it("records non-sensitive text verbatim as a base64 broadcast command", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_input_text",
      arguments: { runId, text: "search query" },
    });
    expect(structured(result).redacted).toBe(false);

    expect(readRecords(runDir, "events").find((e) => e.type === "input_text")).toMatchObject({
      type: "input_text",
      text: "search query",
      redacted: false,
    });
    expect(readRecords(runDir, "commands").find((c) => c.tool === "input_text")).toMatchObject({
      adb: "am broadcast -a ADB_INPUT_B64 --es msg c2VhcmNoIHF1ZXJ5",
    });
  });

  it("placeheld a secret when `sensitive:true` — the raw text never reaches disk", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const secret = "hunter2xyzzy"; // 12 chars, no heuristic trigger word
    const result = await h.client.callTool({
      name: "android_debug_input_text",
      arguments: { runId, text: secret, sensitive: true },
    });
    expect(structured(result).redacted).toBe(true);

    // The Phase 5 hard gate: the raw secret must appear in NEITHER stream.
    expect(readStream(runDir, "events")).not.toContain(secret);
    expect(readStream(runDir, "commands")).not.toContain(secret);

    expect(readRecords(runDir, "events").find((e) => e.type === "input_text")).toMatchObject({
      type: "input_text",
      text: `***${secret.length}`,
      length: secret.length,
      redacted: true,
    });
  });

  it("the input_text heuristic redacts a sensitive word even with no `sensitive` flag (open #8)", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const text = "my password is x"; // contains 'password' → heuristic fires
    const result = await h.client.callTool({
      name: "android_debug_input_text",
      arguments: { runId, text },
    });
    expect(structured(result).redacted).toBe(true);
    expect(readStream(runDir, "events")).not.toContain(text);
    expect(readRecords(runDir, "events").find((e) => e.type === "input_text")).toMatchObject({
      text: `***${text.length}`,
      redacted: true,
    });
  });

  it.each([
    ["Authorization header", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["Cookie header", "Cookie: sid=s3cr3tvalue; theme=dark", "s3cr3tvalue"],
  ])(
    "redacts an embedded-credential string (%s) with no `sensitive` flag — base64 cannot smuggle it",
    async (_label, text, secretFragment) => {
      const h = await harness();
      const { runId, runDir } = await startSession(h);
      const result = await h.client.callTool({
        name: "android_debug_input_text",
        arguments: { runId, text },
      });
      // `redactInputText` does NOT trigger on `Authorization` / `Cookie`; the
      // embedded-credential matcher (`redactString`) must, or the base64
      // command literal would carry a decodable secret past the generic pass.
      expect(structured(result).redacted).toBe(true);

      const rawB64 = Buffer.from(text, "utf8").toString("base64");
      for (const stream of [readStream(runDir, "events"), readStream(runDir, "commands")]) {
        expect(stream).not.toContain(text);
        expect(stream).not.toContain(secretFragment);
        expect(stream).not.toContain(rawB64);
      }
      expect(readRecords(runDir, "events").find((e) => e.type === "input_text")).toMatchObject({
        text: `***${text.length}`,
        redacted: true,
      });
    },
  );

  it("switches the IME to ADBKeyBoard when it is not active, recording the `ime set`", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    imeState.current = "com.other.ime/.SomeIme"; // not ADBKeyBoard
    const result = await h.client.callTool({
      name: "android_debug_input_text",
      arguments: { runId, text: "hello" },
    });
    expect(result.isError).toBeFalsy();

    const inputCommands = readRecords(runDir, "commands").filter((c) => c.tool === "input_text");
    // both the IME switch and the text broadcast land in the audit log.
    expect(inputCommands.some((c) => c.adb === `ime set ${ADB_KEYBOARD_IME}`)).toBe(true);
    expect(
      inputCommands.some((c) => typeof c.adb === "string" && c.adb.startsWith("am broadcast")),
    ).toBe(true);
  });

  it("fails with input_method_unavailable when ADBKeyBoard cannot be selected", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    // ADBKeyBoard is not active AND selecting it does not take (APK absent).
    imeState.current = "com.other.ime/.SomeIme";
    imeState.selectResult = "com.other.ime/.SomeIme";
    const result = await h.client.callTool({
      name: "android_debug_input_text",
      arguments: { runId, text: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("input_method_unavailable");
    // nothing was typed — no input_text event reached the run record.
    expect(readRecords(runDir, "events").find((e) => e.type === "input_text")).toBeUndefined();
  });
});

describe("capture", () => {
  it("captures both kinds, returns a filename-safe captureId and a UI summary", async () => {
    const h = await harness();
    const { runId, runDir } = await startSession(h);
    const result = await h.client.callTool({
      name: "android_debug_capture",
      arguments: { runId, kinds: ["screenshot", "ui_dump"], label: "after login" },
    });
    expect(result.isError).toBeFalsy();
    const sc = structured(result);

    const captureId = sc.captureId as string;
    expect(captureId).toMatch(/^[0-9a-f]{12}$/); // internal id, no caller data
    expect(sc.screenshotPath).toBe(join(runDir, "artifacts", `screenshot-${captureId}.png`));
    expect(sc.uiDumpPath).toBe(join(runDir, "artifacts", `ui-${captureId}.xml`));
    expect(sc.uiSummary).toEqual({
      topActivity: "com.example.app/.MainActivity",
      nodeCount: 3,
      clickableCount: 2,
    });

    expect(readRecords(runDir, "events").find((e) => e.type === "capture")).toMatchObject({
      type: "capture",
      captureId,
      kinds: ["screenshot", "ui_dump"],
      label: "after login",
    });
  });
});

describe("session guards", () => {
  it("an unknown runId fails with no_active_session", async () => {
    const h = await harness();
    await startSession(h); // a session exists, but not this runId
    const result = await h.client.callTool({
      name: "android_debug_tap",
      arguments: { runId: "no-such-run-id", x: 1, y: 1 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("no_active_session");
  });
});
