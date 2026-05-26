import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtractEvidenceContext } from "../../../../src/mcp/tools/extract_evidence_context.ts";
import { registerSearchEvidence } from "../../../../src/mcp/tools/search_evidence.ts";
import { registerStartSession } from "../../../../src/mcp/tools/start_session.ts";
import { registerStopSession } from "../../../../src/mcp/tools/stop_session.ts";
import { SessionManager } from "../../../../src/session/manager.ts";
import { resetPathsCache } from "../../../../src/store/paths.ts";

/**
 * End-to-end integration test for the real `poppo_http` EvidenceSource
 * inside the `poppo-vone` profile, exercised through the search_evidence
 * tool handler.
 *
 * Covers the two contract-amendment scenarios codex flagged in the Phase 4
 * plan audit:
 *
 *   - R1 session scoping: records with `tsMs < sessionStartMs` in the same
 *     retained file MUST NOT leak into the agent's view.
 *   - R2 sort+keyset pagination: records returned across pages MUST be
 *     ordered by `(tsMs, runId, seq)` per the schema's reader contract,
 *     and a `nextCursor` MUST round-trip back to the same source.
 *
 * No real adb here — `adb/adb.ts` and `adb/evidence.ts` are vi.mocked so
 * the "device" is just an in-memory map of `(devicePath → bytes)` set up
 * by the test, and `pullFile` copies those bytes to `localPath`.
 */

// --- in-memory "device" ------------------------------------------------------

interface DeviceFile {
  readonly mtimeMs: number;
  readonly bytes: string;
}

const deviceFiles: Map<string, DeviceFile> = new Map();

/**
 * Names that `ls -1` returns but `statMtimeMs` reports as missing —
 * simulates the race between `listDeviceFiles` listing and the per-file
 * stat call (e.g. the file rotated out of retention between the two).
 * Source impl MUST skip these silently.
 */
const staleLsEntries: Set<string> = new Set();

function setDeviceFile(path: string, mtimeMs: number, bytes: string): void {
  deviceFiles.set(path, { mtimeMs, bytes });
}

function addStaleLsEntry(path: string): void {
  staleLsEntries.add(path);
}

// --- adb / app / logcat mocks ------------------------------------------------

vi.mock("../../../../src/adb/devices.ts", () => ({
  listDevices: async () => [
    { deviceSerial: "FAKEDEV0", state: "device", model: "fake", apiLevel: 33, abi: "arm64-v8a" },
  ],
}));

vi.mock("../../../../src/adb/app.ts", () => ({
  getCurrentUser: async () => 0,
  getPackageVersion: async () => ({ versionName: "9.9.9", versionCode: "999" }),
  getDeviceProps: async () => ({
    model: "fake",
    apiLevel: 33,
    abi: "arm64-v8a",
    buildFingerprint: "fp",
    timezone: "Asia/Shanghai",
  }),
  getAppPids: async () => [],
  getAppUid: async () => "10100",
  launchApp: async () => ({ launched: false, detail: "mock" }),
  getForegroundActivity: async () => ({ activity: "com.example/.Main", foreground: true }),
}));

vi.mock("../../../../src/logcat/channel.ts", () => ({
  LogcatChannel: {
    start: async () => ({
      currentState: "running",
      shutdown: async () => ({
        exitCode: 0,
        signalCode: null,
        killed: false,
        bytesRead: 0,
        linesParsed: 0,
        crashMarkers: 0,
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

// `adb/adb.ts` — only the `shell ls -1 <dir>` path is exercised here. Any
// other runAdb call (e.g. logcat -c) is a no-op success.
vi.mock("../../../../src/adb/adb.ts", () => ({
  runAdb: async (args: readonly string[]) => {
    if (args.length >= 4 && args[2] === "shell" && args[3] === "ls") {
      const dir = args[args.length - 1] as string;
      // `ls` returns both real files AND any stale entries (the race we're
      // simulating where stat will later return null).
      const matching = [...deviceFiles.keys(), ...staleLsEntries]
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1));
      if (matching.length === 0) {
        return {
          args,
          stdout: "",
          stderr: `ls: ${dir}: No such file or directory\n`,
          exitCode: 1,
        };
      }
      return { args, stdout: `${matching.join("\n")}\n`, stderr: "", exitCode: 0 };
    }
    // Other runAdb calls (e.g. start_session's `logcat -c`) — best-effort no-op.
    return { args, stdout: "", stderr: "", exitCode: 0 };
  },
  ADB_TIMEOUT_EXIT_CODE: 124,
  resetAdbPathCache: () => undefined,
}));

// `adb/evidence.ts` — statMtimeMs reads from the in-memory map; pullFile
// writes the configured bytes to the local path.
vi.mock("../../../../src/adb/evidence.ts", () => ({
  statMtimeMs: async (_deviceSerial: string, devicePath: string) => {
    const entry = deviceFiles.get(devicePath);
    return entry === undefined ? null : entry.mtimeMs;
  },
  pullFile: async (_deviceSerial: string, devicePath: string, localPath: string) => {
    const entry = deviceFiles.get(devicePath);
    if (entry === undefined) throw new Error(`mock pullFile: no entry for ${devicePath}`);
    await mkdir(join(localPath, ".."), { recursive: true });
    await writeFile(localPath, entry.bytes, "utf8");
  },
}));

// --- harness ----------------------------------------------------------------

interface Harness {
  client: Client;
  manager: SessionManager;
  projectRoot: string;
}

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "poppo-http-integration-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerSearchEvidence(server, manager);
  registerExtractEvidenceContext(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const dir = mkdtempSync(join(tmpdir(), "adm-v2g-poppo-"));
  execFileSync("git", ["init", "-q", dir]);
  const projectRoot = realpathSync(dir);
  open.push({
    shutdown: async () => {
      for (const s of manager.listActive()) await s.finalize("stopped").catch(() => undefined);
      await client.close();
      await server.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  });
  return { client, manager, projectRoot };
}

function writePoppoVoneProfileJson(projectRoot: string): void {
  const dotDir = join(projectRoot, ".android-debug-mcp");
  execFileSync("mkdir", ["-p", dotDir]);
  writeFileSync(join(dotDir, "profile.json"), JSON.stringify({ name: "poppo-vone", version: 1 }));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-v2g-poppo-runs-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  deviceFiles.clear();
  staleLsEntries.clear();
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.shutdown();
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
  deviceFiles.clear();
  staleLsEntries.clear();
});

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function startPoppoSession(h: Harness): Promise<{ runId: string; sessionStartMs: number }> {
  writePoppoVoneProfileJson(h.projectRoot);
  const before = Date.now();
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.baitu.poppo", projectRoot: h.projectRoot },
  });
  const sc = structured(r);
  // sessionStartMs is captured at start; we approximate by using "before" — any
  // record with tsMs >= before survives the bindSession floor.
  return { runId: sc.runId as string, sessionStartMs: before };
}

// --- fixture builder --------------------------------------------------------

function record(opts: {
  tsMs: number;
  runId: string;
  seq: number;
  path?: string;
  status?: number;
  appOk?: boolean | null;
  heartBeat?: boolean;
  method?: string;
}): string {
  return JSON.stringify({
    v: 1,
    runId: opts.runId,
    seq: opts.seq,
    pid: 18866,
    tsMs: opts.tsMs,
    durationMs: 50,
    method: opts.method ?? "GET",
    url: `https://api.example.com${opts.path ?? "/x"}`,
    path: opts.path ?? "/x",
    host: "api.example.com",
    protocol: "h2",
    heartBeat: opts.heartBeat ?? false,
    request: {
      headers: [],
      params: [],
      decoded: null,
      body: {
        contentType: null,
        charset: null,
        text: null,
        textBytes: null,
        omittedReason: "no-body",
        preview: null,
        previewBytes: null,
      },
    },
    response: {
      status: opts.status ?? 200,
      headers: [],
      body: {
        contentType: "application/json",
        charset: "UTF-8",
        text: '{"k":"v"}',
        textBytes: 9,
        omittedReason: null,
        preview: null,
        previewBytes: null,
      },
      app:
        opts.appOk === undefined
          ? null
          : {
              status: opts.appOk ? "ok" : "err",
              code: null,
              errCode: null,
              errMsg: null,
              message: null,
              ok: opts.appOk,
            },
    },
    error: null,
  });
}

const POPPO_DIR = "/sdcard/Android/data/com.baitu.poppo/files/http-logs";

// --- tests ------------------------------------------------------------------

describe("poppo_http integration — R1 session scoping", () => {
  it("filters pre-session records in the same file (bindSession tsMs floor)", async () => {
    const h = await harness();
    const { runId, sessionStartMs } = await startPoppoSession(h);

    // One file with three records: pre-session, post-session, post-session.
    const today = new Date(sessionStartMs).toISOString().slice(0, 10);
    const file = `${POPPO_DIR}/http_${today}_0.jsonl`;
    const lines = [
      record({ tsMs: sessionStartMs - 60_000, runId: "OLD-RUN", seq: 1, path: "/before" }),
      record({ tsMs: sessionStartMs + 1_000, runId: "NEW-RUN", seq: 1, path: "/after-a" }),
      record({ tsMs: sessionStartMs + 2_000, runId: "NEW-RUN", seq: 2, path: "/after-b" }),
      "",
    ];
    setDeviceFile(file, sessionStartMs + 5_000, lines.join("\n"));

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "poppo_http", tsMsRange: { from: 0 } } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    const records = sc.records as Array<{ path: string; runId: string }>;
    expect(records).toHaveLength(2);
    expect(records.map((x) => x.path)).toEqual(["/after-a", "/after-b"]);
    // The OLD-RUN record's seq=1 collides with NEW-RUN seq=1 in numeric value,
    // but runId discriminates them — pinning that "OLD-RUN" never surfaces.
    expect(records.every((x) => x.runId === "NEW-RUN")).toBe(true);
  });
});

describe("poppo_http integration — R2 sort+keyset pagination", () => {
  it("paginates in (tsMs, runId, seq) order across pages", async () => {
    const h = await harness();
    const { runId, sessionStartMs } = await startPoppoSession(h);

    // Two files. Records interleave by tsMs across the two files — exactly
    // the case where basename ordering would give wrong order.
    const today = new Date(sessionStartMs).toISOString().slice(0, 10);
    const fileA = `${POPPO_DIR}/http_${today}_0.jsonl`;
    const fileB = `${POPPO_DIR}/http_${today}_1.jsonl`;
    setDeviceFile(
      fileA,
      sessionStartMs + 100_000,
      [
        record({ tsMs: sessionStartMs + 1_000, runId: "RUN-1", seq: 1, path: "/r1-1" }),
        record({ tsMs: sessionStartMs + 3_000, runId: "RUN-1", seq: 2, path: "/r1-2" }),
        record({ tsMs: sessionStartMs + 5_000, runId: "RUN-1", seq: 3, path: "/r1-3" }),
        "",
      ].join("\n"),
    );
    setDeviceFile(
      fileB,
      sessionStartMs + 100_000,
      [
        record({ tsMs: sessionStartMs + 2_000, runId: "RUN-2", seq: 1, path: "/r2-1" }),
        record({ tsMs: sessionStartMs + 4_000, runId: "RUN-2", seq: 2, path: "/r2-2" }),
        record({ tsMs: sessionStartMs + 6_000, runId: "RUN-2", seq: 3, path: "/r2-3" }),
        "",
      ].join("\n"),
    );

    const page1 = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "poppo_http", tsMsRange: { from: 0 } }, limit: 2 },
    });
    expect(page1.isError).toBeFalsy();
    const sc1 = structured(page1);
    const recs1 = sc1.records as Array<{ path: string }>;
    expect(recs1.map((r) => r.path)).toEqual(["/r1-1", "/r2-1"]);
    expect(sc1.nextCursor).toBeTypeOf("string");

    const page2 = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "poppo_http", tsMsRange: { from: 0 } },
        limit: 2,
        cursor: sc1.nextCursor,
      },
    });
    expect(page2.isError).toBeFalsy();
    const sc2 = structured(page2);
    const recs2 = sc2.records as Array<{ path: string }>;
    expect(recs2.map((r) => r.path)).toEqual(["/r1-2", "/r2-2"]);
    expect(sc2.nextCursor).toBeTypeOf("string");

    const page3 = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "poppo_http", tsMsRange: { from: 0 } },
        limit: 2,
        cursor: sc2.nextCursor,
      },
    });
    const sc3 = structured(page3);
    const recs3 = sc3.records as Array<{ path: string }>;
    expect(recs3.map((r) => r.path)).toEqual(["/r1-3", "/r2-3"]);
    // Handler omits `nextCursor` from the response when there's no more
    // (output schema declares it optional). Client sees it as undefined.
    expect(sc3.nextCursor).toBeUndefined();
  });
});

describe("poppo_http integration — missing device dir", () => {
  it("returns empty soft-result when /sdcard/.../http-logs does not exist", async () => {
    const h = await harness();
    const { runId } = await startPoppoSession(h);
    // Don't populate deviceFiles → mock runAdb returns exitCode=1 with
    // "No such file or directory" → listDeviceFiles returns [].
    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "poppo_http", tsMsRange: { from: 0 } } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toEqual([]);
    expect((sc.statsRun as { pullsTriggered: number }).pullsTriggered).toBe(0);
  });
});

describe("poppo_http integration — stale ls entry (codex Phase 4 audit V2)", () => {
  it("silently skips a file that `ls` reported but `statMtimeMs` returns null for", async () => {
    const h = await harness();
    const { runId, sessionStartMs } = await startPoppoSession(h);
    const today = new Date(sessionStartMs).toISOString().slice(0, 10);

    // One real file with one record, one stale ls entry (rotated out
    // between `ls` and `stat`). Source MUST skip the stale entry and
    // still surface the real file's record.
    const realFile = `${POPPO_DIR}/http_${today}_0.jsonl`;
    setDeviceFile(
      realFile,
      sessionStartMs + 1_000,
      `${record({
        tsMs: sessionStartMs + 500,
        runId: "RUN-1",
        seq: 1,
        path: "/real",
      })}\n`,
    );
    addStaleLsEntry(`${POPPO_DIR}/http_${today}_1.jsonl`);

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "poppo_http", tsMsRange: { from: 0 } } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    const recs = sc.records as Array<{ path: string; runId: string }>;
    expect(recs).toHaveLength(1);
    expect(recs[0]?.path).toBe("/real");
    // Only the real file was pulled — the stale ls entry was skipped at stat.
    expect((sc.statsRun as { pullsTriggered: number }).pullsTriggered).toBe(1);
  });
});
