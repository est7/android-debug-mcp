import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { AppendStream } from "../../src/store/jsonl.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

// start_session shells `adb` via the Bun runtime; vitest runs under Node where
// `Bun` is undefined. Mock the adb layer so the tool test is hermetic and does
// not require a connected device. (The adb wrappers themselves are covered by
// adb/app.test.ts parsers + the real-device probe.)
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
  launchApp: async () => ({ launched: false, detail: "mock: not launched" }),
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
  const server = new McpServer({ name: "start-session-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const entry: OpenHarness = {
    client,
    manager,
    shutdown: async () => {
      // Finalize any session this test left active, else its global lockfile
      // leaks into the next test (FAKEDEV0/com.example.app would collide).
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
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-startsess-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache(); // runRoot resolution memoizes per (projectRoot,cwd); the
  // env var changes between tests, so the cache must be cleared each time.
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

function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}

describe("start_session tool — failure paths", () => {
  it("rejects a path-traversal packageName as invalid_identity (P3-P2-4)", async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "../evil", clearLocalRunLogs: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("invalid_identity");
    expect(h.manager.listActive()).toHaveLength(0);
  });

  it("starts a session successfully on the happy path", async () => {
    const h = await harness();
    const result = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.app" },
    });
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc?.deviceSerial).toBe("FAKEDEV0");
    expect(sc?.versionName).toBe("1.0.0");
    expect(h.manager.listActive()).toHaveLength(1);
  });

  it("does not strand the session when post-registration work throws (P3-P1-1)", async () => {
    const h = await harness();
    // The first AppendStream.append() after manager.start() is the
    // `session_start` lifecycle event — force it to fail.
    vi.spyOn(AppendStream.prototype, "append").mockRejectedValueOnce(
      new Error("simulated disk failure"),
    );
    const result = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.app" },
    });
    expect(result.isError).toBe(true);
    // Crucially: the session was aborted, not stranded.
    expect(h.manager.listActive()).toHaveLength(0);
    expect(h.manager.registeredCount()).toBe(0);
  });

  it("a retry after a post-start failure can start the same package again (tuple freed)", async () => {
    const h = await harness();
    vi.spyOn(AppendStream.prototype, "append").mockRejectedValueOnce(
      new Error("simulated disk failure"),
    );
    const first = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.app" },
    });
    expect(first.isError).toBe(true);
    expect(h.manager.registeredCount()).toBe(0);
    // Second attempt: no injected failure → must succeed (tuple was freed).
    const second = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.app" },
    });
    expect(second.isError).toBeFalsy();
    expect(h.manager.listActive()).toHaveLength(1);
  });
});
