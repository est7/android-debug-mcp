import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtractCrashContext } from "../../src/mcp/tools/extract_crash_context.ts";
import { registerGetRunSummary } from "../../src/mcp/tools/get_run_summary.ts";
import { registerMarkEvent } from "../../src/mcp/tools/mark_event.ts";
import { registerSearchLogs } from "../../src/mcp/tools/search_logs.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerStopSession } from "../../src/mcp/tools/stop_session.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

// The evidence tools touch only the run folder on disk — no adb. The mocks
// below exist solely so start_session / stop_session run hermetically.
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

const LOG_E = {
  tsRaw: "05-20 10:00:04.000",
  rawLineNo: 4,
  buffer: "main",
  level: "E",
  tag: "App",
  pid: 100,
  tid: 100,
  message: "boom NullPointerException",
};

const RAW_LINES = [
  "05-20 10:00:01.000 100 100 I App: start",
  "05-20 10:00:02.000 100 100 D App: work",
  "05-20 10:00:03.000 100 100 E AndroidRuntime: FATAL EXCEPTION: main",
  "05-20 10:00:03.000 100 100 E AndroidRuntime: java.lang.NullPointerException: boom",
  "05-20 10:00:03.000 100 100 E AndroidRuntime: \tat com.example.Main.run(Main.java:7)",
  "05-20 10:00:04.000 100 100 I App: after",
];

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

interface Harness {
  client: Client;
  manager: SessionManager;
}

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "evidence-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerMarkEvent(server, manager);
  registerSearchLogs(server, manager);
  registerExtractCrashContext(server, manager);
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
  scratch = mkdtempSync(join(tmpdir(), "adm-evidence-"));
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

async function startRun(h: Harness): Promise<{ runId: string; runDir: string }> {
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.evidence" },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

describe("search_logs tool", () => {
  it("searches an active run's logcat.jsonl by level", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    writeFileSync(
      join(runDir, "logcat.jsonl"),
      `${JSON.stringify({ ...LOG_E, level: "I", message: "info line" })}\n${JSON.stringify(LOG_E)}\n`,
    );
    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      arguments: { runId, level: "E" },
    });
    expect(r.isError).toBeFalsy();
    const entries = structured(r).entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("E");
  });

  it("filters an active run's logcat.jsonl by tag", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    writeFileSync(
      join(runDir, "logcat.jsonl"),
      `${JSON.stringify({ ...LOG_E, rawLineNo: 1, tag: "App" })}\n${JSON.stringify({ ...LOG_E, rawLineNo: 2, tag: "Net" })}\n`,
    );
    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      arguments: { runId, tags: ["Net"] },
    });
    expect(r.isError).toBeFalsy();
    const entries = structured(r).entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.rawLineNo)).toEqual([2]);
    expect(entries[0]?.tag).toBe("Net");
  });

  it("rejects an empty `tags` array at the schema boundary", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      arguments: { runId, tags: [] },
    });
    expect(r.isError).toBe(true);
    expect(callText(r)).toContain("tags must list at least one tag");
  });

  it("resolves a mark to an afterMark logcat window", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    // logs before the mark, then the mark anchors the offset, then logs after.
    writeFileSync(join(runDir, "logcat.jsonl"), `${JSON.stringify({ ...LOG_E, rawLineNo: 1 })}\n`);
    await h.client.callTool({
      name: "android_debug_mark_event",
      arguments: { runId, name: "checkpoint" },
    });
    appendFileSync(join(runDir, "logcat.jsonl"), `${JSON.stringify({ ...LOG_E, rawLineNo: 2 })}\n`);
    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      arguments: { runId, afterMark: "checkpoint" },
    });
    const entries = structured(r).entries as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.rawLineNo)).toEqual([2]);
  });

  it("returns run_missing for an unknown runId", async () => {
    const h = await harness();
    await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_search_logs",
      arguments: { runId: "no-such-run" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("run_missing");
  });
});

describe("extract_crash_context tool", () => {
  it("extracts the java crash context from crash.jsonl + logcat.raw.txt", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    writeFileSync(join(runDir, "logcat.raw.txt"), `${RAW_LINES.join("\n")}\n`);
    writeFileSync(
      join(runDir, "crash.jsonl"),
      `${JSON.stringify({ rawLineNo: 3, type: "java", marker: "FATAL EXCEPTION", line: RAW_LINES[2] })}\n`,
    );
    const r = await h.client.callTool({
      name: "android_debug_extract_crash_context",
      arguments: { runId, beforeLines: 2, afterLines: 3 },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.crashCount).toBe(1);
    expect(sc.type).toBe("java");
    expect(sc.mainException).toContain("NullPointerException");
  });

  it("returns crashCount 0 for a run with no crash", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_extract_crash_context",
      arguments: { runId },
    });
    expect(structured(r)).toEqual({ crashCount: 0 });
  });
});

describe("get_run_summary tool", () => {
  it("renders a report for an active run and writes summary.md", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    const r = await h.client.callTool({
      name: "android_debug_get_run_summary",
      arguments: { runId },
    });
    expect(r.isError).toBeFalsy();
    expect(callText(r)).toContain("# Run Summary — com.example.evidence");
    expect(structured(r).packageName).toBe("com.example.evidence");
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
  });

  it("works on a finalized run, located by scanning the run tree", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    // stop_session wrote summary.md on teardown.
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    // get_run_summary on the now-finalized run: no active session, disk scan.
    const r = await h.client.callTool({
      name: "android_debug_get_run_summary",
      arguments: { runId },
    });
    expect(r.isError).toBeFalsy();
    expect(structured(r).status).toBe("stopped");
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toContain("# Run Summary");
  });
});
