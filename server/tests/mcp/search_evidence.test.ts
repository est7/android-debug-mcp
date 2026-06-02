import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sourceEvidenceDir } from "../../src/evidence/paths.ts";
import { registerExtractCrashContext } from "../../src/mcp/tools/extract_crash_context.ts";
import { registerExtractEvidenceContext } from "../../src/mcp/tools/extract_evidence_context.ts";
import {
  computePreviewAudit,
  registerSearchEvidence,
} from "../../src/mcp/tools/search_evidence.ts";
import { registerStartSession } from "../../src/mcp/tools/start_session.ts";
import { registerStopSession } from "../../src/mcp/tools/stop_session.ts";
import { registerTestProfile, unregisterTestProfile } from "../../src/profile/registry.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceSource,
  ParsedRecord,
  Profile,
} from "../../src/profile/types.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

/**
 * End-to-end Phase 3 handler tests (codex audit cadence A target).
 *
 * # Test seam choice
 *
 * Earlier drafts mocked `loadProfile` via `vi.mock`. That leaked across the
 * vitest worker thread when run in parallel with `evidence.test.ts` (the v1
 * search_logs test file): the mock factory's spread of the real module
 * survived `isolate: true`. The fix is `registerTestProfile` — a real,
 * additive registry entry that this file installs in `beforeEach` and removes
 * in `afterEach`. `loadProfile` then sees a normal built-in lookup. No mock,
 * no leakage.
 *
 * # Coverage matrix
 *
 *   - inventory 23
 *   - vanilla session (no profile.json)        → both tools soft-empty + warning
 *   - profile + fake src happy path            → records + evidence_pulled event + commands aggregate
 *   - profile + unknown source                 → soft-empty
 *   - malformed query (.strict() unknown key)  → query_malformed
 *   - cache-hit second call                    → no pull, no new event, commands row still appended
 *   - cursor tamper (foreign runId)            → invalid_cursor
 *   - extract_evidence_context tsMsRange injection happy + echo
 *   - extract_evidence_context refuses agent-supplied tsMsRange
 *   - extract_evidence_context vanilla soft-empty still echoes tsMsRange
 */

// --- adb / app / logcat mocks (mirrors evidence.test.ts) ----------------------

vi.mock("../../src/adb/devices.ts", () => ({
  listDevices: async () => [
    { deviceSerial: "FAKEDEV0", state: "device", model: "fake", apiLevel: 33, abi: "arm64-v8a" },
  ],
}));

const devicePropsState = vi.hoisted(() => ({
  timezone: "Asia/Shanghai" as string | null,
}));

vi.mock("../../src/adb/app.ts", () => ({
  getCurrentUser: async () => 0,
  getPackageVersion: async () => ({ versionName: "9.9.9", versionCode: "999" }),
  getDeviceProps: async () => ({
    model: "fake",
    apiLevel: 33,
    abi: "arm64-v8a",
    buildFingerprint: "fp",
    timezone: devicePropsState.timezone,
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
        crashMarkers: 0,
        bufferInfo: { requested: "16M", effective: null, buffers: [], error: null },
      }),
    }),
  },
}));

// --- fake profile + source ----------------------------------------------------

interface FakeRecord {
  readonly source: "fake_src";
  readonly tsMs: number;
  readonly path: string;
}

const TEST_PROFILE_NAME = "test-fake-profile";

const fakeBytes: Readonly<Record<string, string>> = {
  "/d/http_a.jsonl": ["1716600000000|/api/v1/users", "1716600001000|/api/v1/orders", ""].join("\n"),
};

const fakeFiles: readonly DeviceFileEntry[] = [
  { path: "/d/http_a.jsonl", name: "http_a.jsonl", mtimeMs: 100 },
];

const fakeSource: EvidenceSource = {
  id: "fake_src",
  querySchema: z
    .object({
      source: z.literal("fake_src"),
      pathPrefix: z.string().optional(),
      tsMsRange: z
        .object({
          from: z.number().int().optional(),
          to: z.number().int().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  async listDeviceFiles(_ctx: EvidenceContext) {
    return fakeFiles;
  },
  async pullFile(_ctx, deviceFile, localPath) {
    const data = fakeBytes[deviceFile.path];
    if (data === undefined) throw new Error(`no fake bytes for ${deviceFile.path}`);
    await mkdir(join(localPath, ".."), { recursive: true });
    await writeFile(localPath, data, "utf8");
  },
  parseLine(line) {
    const parts = line.split("|");
    if (parts.length !== 2) return null;
    const ts = Number.parseInt(parts[0] as string, 10);
    if (!Number.isFinite(ts)) return null;
    const r: FakeRecord = { source: "fake_src", tsMs: ts, path: parts[1] as string };
    return r as unknown as ParsedRecord;
  },
  matchQuery(record, query) {
    const r = record as unknown as FakeRecord;
    const q = query as { pathPrefix?: string; tsMsRange?: { from?: number; to?: number } };
    if (q.pathPrefix !== undefined && !r.path.startsWith(q.pathPrefix)) return false;
    if (q.tsMsRange?.from !== undefined && r.tsMs < q.tsMsRange.from) return false;
    if (q.tsMsRange?.to !== undefined && r.tsMs > q.tsMsRange.to) return false;
    return true;
  },
  redactForBundle(record) {
    return record;
  },
};

const fakeProfile: Profile = { name: TEST_PROFILE_NAME, evidenceSources: [fakeSource] };

interface TimelineRecord {
  readonly source: "timeline_http" | "timeline_nav";
  readonly tsMs: number;
  readonly label: string;
}

const MULTI_PROFILE_NAME = "test-multi-source-profile";

function timelineSource(
  id: TimelineRecord["source"],
  devicePath: string,
  bytes: string,
): EvidenceSource {
  return {
    id,
    querySchema: z
      .object({
        source: z.literal(id),
        labelPrefix: z.string().optional(),
        tsMsRange: z
          .object({
            from: z.number().int(),
            to: z.number().int(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async listDeviceFiles(_ctx: EvidenceContext) {
      return [{ path: devicePath, name: `${id}.jsonl`, mtimeMs: 100 }];
    },
    async pullFile(_ctx, _deviceFile, localPath) {
      await mkdir(join(localPath, ".."), { recursive: true });
      await writeFile(localPath, bytes, "utf8");
    },
    parseLine(line) {
      const parts = line.split("|");
      if (parts.length !== 2) return null;
      const tsMs = Number.parseInt(parts[0] as string, 10);
      if (!Number.isFinite(tsMs)) return null;
      return { source: id, tsMs, label: parts[1] as string } satisfies TimelineRecord;
    },
    matchQuery(record, query) {
      const r = record as unknown as TimelineRecord;
      const q = query as { labelPrefix?: string; tsMsRange?: { from: number; to: number } };
      if (q.labelPrefix !== undefined && !r.label.startsWith(q.labelPrefix)) return false;
      if (q.tsMsRange !== undefined) {
        if (r.tsMs < q.tsMsRange.from) return false;
        if (r.tsMs > q.tsMsRange.to) return false;
      }
      return true;
    },
    redactForBundle(record) {
      return record;
    },
    previewForAgent(record) {
      return {
        record,
        truncated: false,
        fullSizeBytes: Buffer.byteLength(JSON.stringify(record), "utf8"),
        truncatedFields: [],
        available: [],
        sizes: {},
      };
    },
  };
}

const multiProfile: Profile = {
  name: MULTI_PROFILE_NAME,
  evidenceSources: [
    timelineSource(
      "timeline_http",
      "/d/timeline_http.jsonl",
      [
        "1716600000400|out-before",
        "1716600000500|http-a",
        "1716600000700|http-b",
        "1716600001001|out-after",
        "",
      ].join("\n"),
    ),
    timelineSource(
      "timeline_nav",
      "/d/timeline_nav.jsonl",
      ["1716600000600|nav-a", "1716600000800|nav-b", ""].join("\n"),
    ),
  ],
};

const UNIFIED_PROFILE_NAME = "test-unified-timeline-profile";
const UNIFIED_BASE_MS = new Date("2026-05-20T10:15:49.000+08:00").getTime();

const unifiedProfile: Profile = {
  name: UNIFIED_PROFILE_NAME,
  evidenceSources: [
    timelineSource(
      "timeline_http",
      "/d/unified_http.jsonl",
      [`${UNIFIED_BASE_MS + 300}|http-after-tap`, `${UNIFIED_BASE_MS + 900}|http-late`, ""].join(
        "\n",
      ),
    ),
    timelineSource(
      "timeline_nav",
      "/d/unified_nav.jsonl",
      [`${UNIFIED_BASE_MS + 200}|nav-after-tap`, ""].join("\n"),
    ),
  ],
  logcatTimelineExcludeTags: ["http/heart-beat"],
};

// --- harness ------------------------------------------------------------------

interface Harness {
  client: Client;
  manager: SessionManager;
  projectRoot: string;
}

let scratch = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

async function harness(): Promise<Harness> {
  const server = new McpServer({ name: "search-evidence-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerStartSession(server, manager);
  registerStopSession(server, manager);
  registerSearchEvidence(server, manager);
  registerExtractEvidenceContext(server, manager);
  registerExtractCrashContext(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  // Each harness uses its own projectRoot. `start_session` normalizes via
  // `git rev-parse --show-toplevel`, so the dir MUST be a git repo or
  // loadProfile() never gets called (vanilla path). `realpathSync` matches
  // git's symlink-resolved output on macOS where /tmp = /private/tmp.
  const dir = mkdtempSync(join(tmpdir(), "adm-v2g-pr-"));
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

function writeProfileJson(projectRoot: string, profileName: string): void {
  mkdirSync(join(projectRoot, ".android-debug-mcp"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".android-debug-mcp", "profile.json"),
    JSON.stringify({ name: profileName, version: 1 }),
  );
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-v2g-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  registerTestProfile(fakeProfile);
  registerTestProfile(multiProfile);
  registerTestProfile(unifiedProfile);
  devicePropsState.timezone = "Asia/Shanghai";
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.shutdown();
  unregisterTestProfile(UNIFIED_PROFILE_NAME);
  unregisterTestProfile(MULTI_PROFILE_NAME);
  unregisterTestProfile(TEST_PROFILE_NAME);
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

async function startRun(
  h: Harness,
  opts: { withProfile?: boolean; profileName?: string } = {},
): Promise<{ runId: string; runDir: string }> {
  if (opts.profileName !== undefined) {
    writeProfileJson(h.projectRoot, opts.profileName);
  } else if (opts.withProfile === true) {
    writeProfileJson(h.projectRoot, TEST_PROFILE_NAME);
  }
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
}

function writeUnifiedTimelineFiles(runDir: string): void {
  writeFileSync(
    join(runDir, "logcat.jsonl"),
    [
      JSON.stringify({
        tsRaw: "05-20 10:15:49.250",
        rawLineNo: 10,
        buffer: "main",
        level: "W",
        tag: "Poppo",
        pid: 1234,
        tid: 1235,
        message: "tap triggered warning",
      }),
      JSON.stringify({
        tsRaw: "05-20 10:15:49.450",
        rawLineNo: 11,
        buffer: "main",
        level: "E",
        tag: "AndroidRuntime",
        pid: 1234,
        tid: 1235,
        message: "FATAL EXCEPTION: main",
      }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "events.jsonl"),
    [
      JSON.stringify({
        type: "mark",
        name: "tap",
        ts: new Date(UNIFIED_BASE_MS + 100).toISOString(),
      }),
      JSON.stringify({
        type: "crash",
        crashType: "java",
        topFrame: "com.baitu.poppo.HomepageActivity.onCreate",
        ts: new Date(UNIFIED_BASE_MS + 400).toISOString(),
      }),
      JSON.stringify({
        type: "evidence_pulled",
        source: "timeline_http",
        trigger: "lazy",
        ts: new Date(UNIFIED_BASE_MS + 500).toISOString(),
      }),
      "",
    ].join("\n"),
  );
  const rawLines = [
    "05-20 10:15:49.430  1234  1235 E AndroidRuntime: FATAL EXCEPTION: main",
    "05-20 10:15:49.431  1234  1235 E AndroidRuntime: java.lang.NullPointerException: boom",
    "05-20 10:15:49.432  1234  1235 E AndroidRuntime: \tat com.baitu.poppo.HomepageActivity.onCreate(HomepageActivity.kt:42)",
  ];
  writeFileSync(join(runDir, "logcat.raw.txt"), `${rawLines.join("\n")}\n`);
  writeFileSync(
    join(runDir, "crash.jsonl"),
    `${JSON.stringify({ rawLineNo: 1, type: "java", marker: "FATAL EXCEPTION", line: rawLines[0] })}\n`,
  );
}

// --- tests --------------------------------------------------------------------

describe("search_evidence — Q11 soft-empty", () => {
  it("vanilla session (no profile) → empty records + warning, no events.jsonl event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h); // no profile.json

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toEqual([]);
    expect((sc.warnings as string[])[0]).toContain("session has no profile loaded");
    expect((sc.statsRun as { pullsTriggered: number }).pullsTriggered).toBe(0);

    if (existsSync(join(runDir, "events.jsonl"))) {
      const text = readFileSync(join(runDir, "events.jsonl"), "utf8");
      expect(text).not.toContain("evidence_pulled");
    }
  });

  it("profile loaded but query.source unknown → soft-empty with profile name in warning", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "missing_src" } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toEqual([]);
    expect((sc.warnings as string[])[0]).toContain(TEST_PROFILE_NAME);
    expect((sc.warnings as string[])[0]).toContain("missing_src");
  });
});

describe("search_evidence — happy path", () => {
  it("first call: pulls + records + cache-write + evidence_pulled event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h, { withProfile: true });

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toHaveLength(2);
    const stats = sc.statsRun as { pullsTriggered: number; pulledFiles: string[] };
    expect(stats.pullsTriggered).toBe(1);
    expect(stats.pulledFiles).toEqual([
      join(sourceEvidenceDir(runDir, "fake_src"), "http_a.jsonl"),
    ]);
    expect((sc.statsRun as { bytesPulled: number }).bytesPulled).toBe(
      Buffer.byteLength(fakeBytes["/d/http_a.jsonl"] as string, "utf8"),
    );

    const eventsText = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(eventsText).toContain("evidence_pulled");
    expect(eventsText).toContain(`"source":"fake_src"`);
    expect(eventsText).toContain(`"trigger":"lazy"`);
    expect(eventsText).toContain(`"bytesPulled":`);
    expect(eventsText).toContain(`"fileBytes":`);
  });

  it("second call (cache hit): no pull, no new evidence_pulled event, commands row appended", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h, { withProfile: true });

    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    const eventsAfterFirst = readFileSync(join(runDir, "events.jsonl"), "utf8");
    const evidenceEventCountFirst = (eventsAfterFirst.match(/evidence_pulled/g) ?? []).length;

    const r2 = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    expect(r2.isError).toBeFalsy();
    const stats = structured(r2).statsRun as { pullsTriggered: number };
    expect(stats.pullsTriggered).toBe(0);

    const eventsAfterSecond = readFileSync(join(runDir, "events.jsonl"), "utf8");
    const evidenceEventCountSecond = (eventsAfterSecond.match(/evidence_pulled/g) ?? []).length;
    expect(evidenceEventCountSecond).toBe(evidenceEventCountFirst);

    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const commandsCount = commandsText
      .split("\n")
      .filter((l) => l.includes("search_evidence")).length;
    expect(commandsCount).toBe(2);
  });
});

describe("search_evidence — strict per-source validation", () => {
  it("unknown key in query (.strict) → query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src", junk: 1 } },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("query_malformed");
  });
});

describe("search_evidence — cursor integrity", () => {
  it("order desc + cursor → query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "fake_src" },
        order: "desc",
        cursor: "opaque-from-old-page",
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; message: string };
    expect(err.error).toBe("query_malformed");
    expect(err.message).toBe("desc order does not paginate; omit cursor");
  });

  it("tampered cursor (foreign runId) → invalid_cursor", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    // Populate cache so the file is actually present locally.
    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    const tampered = Buffer.from(
      JSON.stringify({
        kind: "stream",
        runId: "INTRUDER",
        source: "fake_src",
        fileKey: "http_a.jsonl",
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" }, cursor: tampered },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("invalid_cursor");
  });
});

describe("search_evidence — order desc", () => {
  it("current page recipe: streaming nav source returns the max-tsMs row at records[0]", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { profileName: MULTI_PROFILE_NAME });

    const r = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "timeline_nav" },
        order: "desc",
        limit: 1,
      },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.nextCursor).toBeUndefined();
    expect(sc.records).toHaveLength(1);
    expect((sc.records as Record<string, unknown>[])[0]).toMatchObject({
      source: "timeline_nav",
      tsMs: 1_716_600_000_800,
      label: "nav-b",
    });
  });
});

describe("extract_evidence_context", () => {
  it("rejects calls that provide both query and sources as query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
        query: { source: "fake_src" },
        sources: [{ source: "fake_src" }],
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; message: string };
    expect(err.error).toBe("query_malformed");
    expect(err.message).toContain("query and sources are mutually exclusive");
  });

  it("rejects calls that provide neither query nor sources as query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; message: string };
    expect(err.error).toBe("query_malformed");
    expect(err.message).toContain("one of query or sources is required");
  });

  it("multi-source mode injects the marker window into each source, merges by tsMs, truncates after limit, and warns", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, MULTI_PROFILE_NAME);
    const { runId } = await startRun(h);

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000750).toISOString(),
        beforeMs: 250,
        afterMs: 250,
        sources: [{ source: "timeline_http" }, { source: "timeline_nav" }],
        limit: 3,
      },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.tsMsRange).toEqual({ from: 1716600000500, to: 1716600001000 });
    expect(sc.nextCursor).toBeUndefined();
    expect(sc.warnings).toEqual([
      'multi-source truncated at limit; narrow ts/sources or inspect log volume with search_logs({count:true, groupBy:"tag"})',
    ]);
    expect(sc.statsRun).toMatchObject({
      filesScanned: 2,
      recordsScanned: 6,
      pullsTriggered: 2,
    });
    const records = sc.records as Array<{
      source: string;
      tsMs: number;
      label: string;
      _meta?: {
        preview?: { truncated: boolean; available?: string[]; sizes?: Record<string, number> };
      };
    }>;
    expect(records.map((r) => [r.source, r.tsMs, r.label])).toEqual([
      ["timeline_http", 1716600000500, "http-a"],
      ["timeline_nav", 1716600000600, "nav-a"],
      ["timeline_http", 1716600000700, "http-b"],
    ]);
    expect(records.every((r) => r._meta?.preview?.truncated === false)).toBe(true);
    expect(records.every((r) => r._meta?.preview?.available?.length === 0)).toBe(true);
  });

  it("multi-source timeline merges events, logcat, and evidence records by epoch tsMs", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeUnifiedTimelineFiles(runDir);

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 300).toISOString(),
        beforeMs: 250,
        afterMs: 250,
        sources: [
          { source: "events" },
          { source: "timeline_nav" },
          { source: "logcat", level: "W" },
          { source: "timeline_http" },
        ],
        limit: 10,
      },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.warnings).toBeUndefined();
    const records = sc.records as Array<{
      source: string;
      tsMs: number;
      type?: string;
      label?: string;
      level?: string;
      rawLineNoFirst?: number;
      ref?: string;
    }>;
    expect(
      records.map((rec) => [rec.source, rec.tsMs, rec.type ?? rec.label ?? rec.level]),
    ).toEqual([
      ["events", UNIFIED_BASE_MS + 100, "mark"],
      ["timeline_nav", UNIFIED_BASE_MS + 200, "nav-after-tap"],
      ["logcat", UNIFIED_BASE_MS + 250, "W"],
      ["timeline_http", UNIFIED_BASE_MS + 300, "http-after-tap"],
      ["events", UNIFIED_BASE_MS + 400, "crash"],
      ["logcat", UNIFIED_BASE_MS + 450, "E"],
    ]);
    expect(records.find((rec) => rec.source === "logcat")).toMatchObject({
      rawLineNoFirst: 10,
      level: "W",
      count: 1,
    });
    expect(records.find((rec) => rec.source === "events" && rec.type === "crash")).toMatchObject({
      ref: "crash#0",
    });

    const crashContext = await h.client.callTool({
      name: "android_debug_extract_crash_context",
      arguments: { runId, crashIndex: 0, beforeLines: 0, afterLines: 2 },
    });
    expect(crashContext.isError).toBeFalsy();
    expect(structured(crashContext).mainException).toContain("NullPointerException");
  });

  it("redacts device IDs and signatures in logcat timeline messages (egress)", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    const piiUrl =
      "FullURL: https://x/user/info?_sign=SECRETSIG&_uid=37142512&smei_id=SMEISECRET&uuid=9906b772cd3b27a0";
    writeFileSync(
      join(runDir, "logcat.jsonl"),
      `${JSON.stringify({
        tsRaw: "05-20 10:15:49.250",
        rawLineNo: 10,
        buffer: "main",
        level: "D",
        tag: "http/heart-beat",
        pid: 1234,
        tid: 1235,
        message: piiUrl,
      })}\n`,
    );

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 250).toISOString(),
        beforeMs: 250,
        afterMs: 250,
        sources: [{ source: "logcat", tags: ["http/heart-beat"] }],
        limit: 10,
      },
    });

    expect(r.isError).toBeFalsy();
    const records = structured(r).records as Array<{ source: string; sample?: string }>;
    const logRec = records.find((rec) => rec.source === "logcat");
    expect(logRec, "logcat row must be present in the window").toBeDefined();
    const msg = logRec?.sample ?? "";
    expect(msg).not.toContain("9906b772cd3b27a0");
    expect(msg).not.toContain("SECRETSIG");
    expect(msg).not.toContain("37142512");
    expect(msg).not.toContain("SMEISECRET");
    expect(msg).toContain("uuid=***");
    expect(msg).toContain("_sign=***");
  });

  it("default-excludes profile noisy tags from the logcat timeline, but honors explicit tags (F2)", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeFileSync(
      join(runDir, "logcat.jsonl"),
      [
        JSON.stringify({
          tsRaw: "05-20 10:15:49.240",
          rawLineNo: 1,
          buffer: "main",
          level: "D",
          tag: "http/heart-beat",
          pid: 1,
          tid: 1,
          message: "#1 GET /user/info",
        }),
        JSON.stringify({
          tsRaw: "05-20 10:15:49.260",
          rawLineNo: 2,
          buffer: "main",
          level: "D",
          tag: "AppFlow",
          pid: 1,
          tid: 1,
          message: "screen rendered",
        }),
        "",
      ].join("\n"),
    );

    const callWith = async (
      logcat: Record<string, unknown>,
    ): Promise<Array<string | undefined>> => {
      const r = await h.client.callTool({
        name: "android_debug_extract_evidence_context",
        arguments: {
          runId,
          markerIsoTs: new Date(UNIFIED_BASE_MS + 250).toISOString(),
          beforeMs: 250,
          afterMs: 250,
          sources: [logcat],
          limit: 10,
        },
      });
      expect(r.isError).toBeFalsy();
      return (structured(r).records as Array<{ tag?: string }>).map((rec) => rec.tag);
    };

    // No explicit `tags` → the profile's noisy tag is excluded by default.
    const def = await callWith({ source: "logcat", level: "D" });
    expect(def).toContain("AppFlow");
    expect(def).not.toContain("http/heart-beat");

    // Explicit `tags:["http/heart-beat"]` → opts the noisy tag back in.
    const opted = await callWith({ source: "logcat", tags: ["http/heart-beat"] });
    expect(opted).toContain("http/heart-beat");
  });

  it("caps compact logcat contribution before final timeline merge", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeFileSync(
      join(runDir, "logcat.jsonl"),
      Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({
          tsRaw: `05-20 10:15:49.${String(100 + i).padStart(3, "0")}`,
          rawLineNo: i + 1,
          buffer: "main",
          level: "D",
          tag: `Tag${i}`,
          pid: 1,
          tid: 1,
          message: `line ${i}`,
        }),
      ).join("\n"),
    );

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 105).toISOString(),
        beforeMs: 250,
        afterMs: 250,
        sources: [{ source: "logcat", level: "D" }],
        limit: 20,
      },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records as Array<unknown>).toHaveLength(5);
    expect(sc.warnings).toEqual([
      'logcat timeline truncated before merge; narrow logcat filters or inspect tags with search_logs({count:true, groupBy:"tag"})',
    ]);
  });

  it("rejects logcat timeline source without a positive narrowing filter", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeUnifiedTimelineFiles(runDir);

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 300).toISOString(),
        sources: [{ source: "logcat" }],
      },
    });

    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; message: string };
    expect(err.error).toBe("query_malformed");
    expect(err.message).toContain("logcat timeline requires at least one narrowing filter");
  });

  it("returns a logcat warning but keeps other sources when device timezone is unknown", async () => {
    const h = await harness();
    devicePropsState.timezone = null;
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeUnifiedTimelineFiles(runDir);

    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 300).toISOString(),
        beforeMs: 250,
        afterMs: 250,
        sources: [{ source: "logcat", level: "W" }, { source: "timeline_nav" }],
      },
    });

    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.warnings).toEqual(["logcat timeline unavailable: device timezone unknown"]);
    const records = sc.records as Array<{ source: string; label?: string }>;
    expect(records).toEqual([
      expect.objectContaining({ source: "timeline_nav", label: "nav-after-tap" }),
    ]);
  });

  it("suppresses evidence_pulled events by default but returns them when typeIn explicitly asks", async () => {
    const h = await harness();
    writeProfileJson(h.projectRoot, UNIFIED_PROFILE_NAME);
    const { runId, runDir } = await startRun(h);
    writeUnifiedTimelineFiles(runDir);

    const defaultOut = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 500).toISOString(),
        beforeMs: 0,
        afterMs: 0,
        sources: [{ source: "events" }],
      },
    });
    expect(defaultOut.isError).toBeFalsy();
    expect(structured(defaultOut).records).toEqual([]);

    const explicitOut = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(UNIFIED_BASE_MS + 500).toISOString(),
        beforeMs: 0,
        afterMs: 0,
        sources: [{ source: "events", typeIn: ["evidence_pulled"] }],
      },
    });
    expect(explicitOut.isError).toBeFalsy();
    expect(structured(explicitOut).records).toEqual([
      expect.objectContaining({
        source: "events",
        tsMs: UNIFIED_BASE_MS + 500,
        type: "evidence_pulled",
      }),
    ]);
  });

  it("injects tsMsRange from markerIsoTs + before/afterMs and echoes it back", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
        beforeMs: 1500,
        afterMs: 1500,
        query: { source: "fake_src" },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toHaveLength(2);
    expect(sc.tsMsRange).toEqual({ from: 1716599999000, to: 1716600002000 });
  });

  it("refuses agent-supplied tsMsRange (invalid_argument)", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
        query: { source: "fake_src", tsMsRange: { from: 0, to: 1 } },
      },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string };
    expect(err.error).toBe("invalid_argument");
  });

  it("explains the 60s beforeMs/afterMs schema limit with a retry hint", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { withProfile: true });
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
        beforeMs: 120_000,
        afterMs: 20_000,
        query: { source: "fake_src" },
      },
    });
    expect(r.isError).toBe(true);
    const text = callText(r);
    expect(text).toContain("beforeMs must be <= 60000");
    expect(text).toContain("Retry with beforeMs <= 60000");
  });

  it("vanilla session → soft-empty with tsMsRange echoed", async () => {
    const h = await harness();
    const { runId } = await startRun(h); // no profile
    const r = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1716600000500).toISOString(),
        beforeMs: 100,
        afterMs: 100,
        query: { source: "fake_src" },
      },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.records).toEqual([]);
    expect(sc.tsMsRange).toEqual({ from: 1716600000400, to: 1716600000600 });
    expect((sc.warnings as string[])[0]).toContain("session has no profile loaded");
  });
});

describe("stop_session — seal-pull (codex amendment #1)", () => {
  it('profile with sources → seal emits evidence_pulled trigger:"seal"', async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h, { withProfile: true });
    // Do NOT run search_evidence first — seal should pull even from an empty
    // cache (the no-prior-search-but-still-want-evidence-in-bundle case).
    const r = await h.client.callTool({
      name: "android_debug_stop_session",
      arguments: { runId },
    });
    expect(r.isError).toBeFalsy();

    const eventsText = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(eventsText).toContain(`"trigger":"seal"`);
    expect(eventsText).toContain(`"source":"fake_src"`);
    expect(eventsText).toContain("http_a.jsonl");
  });

  it("vanilla session stop emits no evidence_pulled event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h); // no profile
    await h.client.callTool({
      name: "android_debug_stop_session",
      arguments: { runId },
    });
    if (existsSync(join(runDir, "events.jsonl"))) {
      const text = readFileSync(join(runDir, "events.jsonl"), "utf8");
      expect(text).not.toContain("evidence_pulled");
    }
  });

  it("seal after a search_evidence: unchanged file emits no duplicate seal pull event", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h, { withProfile: true });
    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    const before = readFileSync(join(runDir, "events.jsonl"), "utf8");
    const lazyCount = (before.match(/"trigger":"lazy"/g) ?? []).length;
    const sealCount0 = (before.match(/"trigger":"seal"/g) ?? []).length;
    expect(lazyCount).toBe(1);
    expect(sealCount0).toBe(0);

    await h.client.callTool({
      name: "android_debug_stop_session",
      arguments: { runId },
    });
    const after = readFileSync(join(runDir, "events.jsonl"), "utf8");
    const sealCount1 = (after.match(/"trigger":"seal"/g) ?? []).length;
    expect(sealCount1).toBe(0);
  });
});

describe("inventory", () => {
  it("server lists both v2-G tools by name", async () => {
    const h = await harness();
    const result = await h.client.listTools();
    const names = new Set(result.tools.map((t) => t.name));
    expect(names.has("android_debug_search_evidence")).toBe(true);
    expect(names.has("android_debug_extract_evidence_context")).toBe(true);
  });
});

// --- v2-G.1 Phase 3 — fullRecords + reject path -----------------------------

const PREVIEW_PROFILE_NAME = "test-fake-preview-profile";

const fakeSourceWithPreview: EvidenceSource = {
  ...fakeSource,
  previewForAgent(record, opts) {
    const r = record as unknown as FakeRecord;
    return {
      record: {
        ...r,
        path: opts.fullRecords === true ? "[full-redacted]" : "[preview]",
        fieldEcho: opts.fields ?? [],
      } as unknown as ParsedRecord,
      truncated: opts.fullRecords !== true,
      fullSizeBytes: 9999,
      truncatedFields: opts.fullRecords === true ? [] : ["path"],
      available: ["path"],
      sizes: { path: Buffer.byteLength(JSON.stringify(r.path), "utf8") },
    };
  },
};

const fakePreviewProfile: Profile = {
  name: PREVIEW_PROFILE_NAME,
  evidenceSources: [fakeSourceWithPreview],
};

describe("v2-G.1 Phase 3 — fullRecords + reject path", () => {
  beforeEach(() => {
    registerTestProfile(fakePreviewProfile);
  });
  afterEach(() => {
    unregisterTestProfile(PREVIEW_PROFILE_NAME);
  });

  it("search_evidence default (no fullRecords): records carry _meta.preview when source declares hook", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    // Re-start under preview profile so the session loads it.
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId: newRunId, query: { source: "fake_src", pathPrefix: "/api" } },
    });
    expect(out.isError).toBeFalsy();
    const sc = structured(out);
    const records = sc.records as Array<{ path: string; _meta?: { preview?: unknown } }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.path).toBe("[preview]");
      expect(rec._meta?.preview).toBeDefined();
    }
  });

  it("search_evidence fullRecords:true: records still go through preview hook and carry metadata", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId: newRunId,
        query: { source: "fake_src", pathPrefix: "/api" },
        limit: 5, // must be <= 10 when fullRecords:true (Phase 3 reject gate)
        fullRecords: true,
      },
    });
    expect(out.isError).toBeFalsy();
    const sc = structured(out);
    const records = sc.records as Array<{
      path: string;
      _meta?: {
        preview?: { truncated: boolean; available?: string[]; sizes?: Record<string, number> };
      };
    }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.path).toBe("[full-redacted]");
      expect(rec._meta?.preview?.truncated).toBe(false);
      expect(rec._meta?.preview?.available).toEqual(["path"]);
      expect(rec._meta?.preview?.sizes?.path).toBeGreaterThan(0);
    }
  });

  it("search_evidence fullRecords:true + limit=10: allowed (boundary inclusive)", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "fake_src", pathPrefix: "/api" },
        limit: 10,
        fullRecords: true,
      },
    });
    // vanilla session → soft-empty (no profile loaded), but the reject gate
    // runs BEFORE dispatch — limit=10 must NOT trip the reject regardless.
    expect(out.isError).toBeFalsy();
  });

  it("search_evidence fullRecords:true + limit=11: rejects as query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "fake_src", pathPrefix: "/api" },
        limit: 11,
        fullRecords: true,
      },
    });
    expect(out.isError).toBe(true);
    expect(callText(out)).toContain("query_malformed");
    expect(callText(out)).toMatch(/fullRecords:true requires limit <= 10/);
  });

  it("extract_evidence_context fullRecords:true: records still go through preview hook", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId: newRunId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        beforeMs: 1000,
        afterMs: 2000,
        query: { source: "fake_src" },
        limit: 5, // must be <= 10 when fullRecords:true (Phase 3 reject gate)
        fullRecords: true,
      },
    });
    expect(out.isError).toBeFalsy();
    const sc = structured(out);
    const records = sc.records as Array<{
      path: string;
      _meta?: { preview?: { truncated: boolean } };
    }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.path).toBe("[full-redacted]");
      expect(rec._meta?.preview?.truncated).toBe(false);
    }
  });

  it("extract_evidence_context fullRecords:true + limit=11: rejects as query_malformed", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    const out = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        query: { source: "fake_src" },
        limit: 11,
        fullRecords: true,
      },
    });
    expect(out.isError).toBe(true);
    expect(callText(out)).toContain("query_malformed");
    expect(callText(out)).toMatch(/fullRecords:true requires limit <= 10/);
  });

  it("commands.jsonl audit row carries Phase 4 preview-audit fields (preview path)", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const sc2 = structured(r2);
    const newRunId = sc2.runId as string;
    const runDir = sc2.runDir as string;

    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId: newRunId, query: { source: "fake_src", pathPrefix: "/api" } },
    });

    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const searchRow = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"search_evidence"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(searchRow).toBeDefined();
    expect(searchRow?.fullRecords).toBe(false);
    expect(searchRow?.truncatedRecords).toBeGreaterThan(0);
    expect(searchRow?.truncatedFullBytesSum).toBe((searchRow?.truncatedRecords as number) * 9999);
    // savedBytesSum = fullSizeBytes - byteLen(previewedRecord). previewed
    // record is {source, tsMs, path:"[preview]", _meta:{preview:{...}}}; for
    // every truncated record (~110 bytes) saved ≈ 9999 - byteLen(rec).
    expect(searchRow?.savedBytesSum).toBeGreaterThan(0);
    expect(searchRow?.savedBytesSum).toBeLessThan(searchRow?.truncatedFullBytesSum as number);
  });

  it("commands preview audit ignores redacted-only preview metadata", () => {
    const audit = computePreviewAudit(
      [
        {
          source: "poppo_http",
          url: "https://api.example.com/?uid=%5BREDACTED%5D",
          _meta: {
            preview: {
              truncated: false,
              fullSizeBytes: 5000,
              truncatedFields: [],
              redactedFields: ["url"],
            },
          },
        },
      ],
      false,
    );
    expect(audit).toEqual({
      fullRecords: false,
      truncatedRecords: 0,
      truncatedFullBytesSum: 0,
      savedBytesSum: 0,
    });
  });

  it("search_evidence fields: forwards projection fields and returns available/sizes metadata", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId: newRunId,
        query: { source: "fake_src", pathPrefix: "/api" },
        fields: ["path"],
      },
    });
    expect(out.isError).toBeFalsy();
    const records = structured(out).records as Array<{
      fieldEcho: string[];
      _meta?: { preview?: { available?: string[]; sizes?: Record<string, number> } };
    }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.fieldEcho).toEqual(["path"]);
      expect(rec._meta?.preview?.available).toEqual(["path"]);
      expect(rec._meta?.preview?.sizes?.path).toBeGreaterThan(0);
    }
  });

  it("search_evidence order desc with fields/fullRecords still applies preview", async () => {
    const h = await harness();
    const { runId } = await startRun(h, { profileName: PREVIEW_PROFILE_NAME });

    const out = await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "fake_src", pathPrefix: "/api" },
        order: "desc",
        limit: 1,
        fields: ["path"],
        fullRecords: true,
      },
    });

    expect(out.isError).toBeFalsy();
    const sc = structured(out);
    expect(sc.nextCursor).toBeUndefined();
    const records = sc.records as Array<{
      path: string;
      fieldEcho: string[];
      tsMs: number;
      _meta?: { preview?: { truncated: boolean; available?: string[] } };
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tsMs: 1_716_600_001_000,
      path: "[full-redacted]",
      fieldEcho: ["path"],
      _meta: { preview: { truncated: false, available: ["path"] } },
    });
  });

  it("commands.jsonl audit row: fullRecords:true → sums all 0", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const sc2 = structured(r2);
    const newRunId = sc2.runId as string;
    const runDir = sc2.runDir as string;

    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId: newRunId,
        query: { source: "fake_src", pathPrefix: "/api" },
        limit: 5,
        fullRecords: true,
      },
    });

    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const searchRow = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"search_evidence"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(searchRow?.fullRecords).toBe(true);
    expect(searchRow?.truncatedRecords).toBe(0);
    expect(searchRow?.truncatedFullBytesSum).toBe(0);
    expect(searchRow?.savedBytesSum).toBe(0);
  });

  it("commands.jsonl audit row: vanilla soft-empty still includes Phase 4 fields", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h); // no profile → soft-empty
    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: { runId, query: { source: "fake_src" } },
    });
    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const row = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"search_evidence"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(row?.softEmpty).toBe(true);
    expect(row?.fullRecords).toBe(false);
    expect(row?.truncatedRecords).toBe(0);
    expect(row?.truncatedFullBytesSum).toBe(0);
    expect(row?.savedBytesSum).toBe(0);
  });

  it("commands.jsonl audit row: query_malformed reject path does NOT write a row", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h);
    await h.client.callTool({
      name: "android_debug_search_evidence",
      arguments: {
        runId,
        query: { source: "fake_src", pathPrefix: "/api" },
        limit: 11,
        fullRecords: true,
      },
    });
    // commands.jsonl may or may not exist depending on whether anything else
    // wrote to it. The point: no search_evidence row from THIS call.
    const exists = (() => {
      try {
        readFileSync(join(runDir, "commands.jsonl"), "utf8");
        return true;
      } catch {
        return false;
      }
    })();
    if (exists) {
      const text = readFileSync(join(runDir, "commands.jsonl"), "utf8");
      expect(text.includes('"tool":"search_evidence"')).toBe(false);
    }
  });

  it("extract_evidence_context default: records carry _meta.preview", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId: newRunId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        beforeMs: 1000,
        afterMs: 2000,
        query: { source: "fake_src" },
      },
    });
    expect(out.isError).toBeFalsy();
    const sc = structured(out);
    const records = sc.records as Array<{
      path: string;
      _meta?: {
        preview?: { truncated: boolean; fullSizeBytes: number; truncatedFields: string[] };
      };
    }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec._meta?.preview?.truncated).toBe(true);
      expect(rec._meta?.preview?.fullSizeBytes).toBe(9999);
      expect(rec._meta?.preview?.truncatedFields).toEqual(["path"]);
    }
  });

  it("extract_evidence_context fields: forwards projection fields to searchEvidence", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const newRunId = (structured(r2).runId as string) ?? "";

    const out = await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId: newRunId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        beforeMs: 1000,
        afterMs: 2000,
        query: { source: "fake_src" },
        fields: ["path"],
      },
    });
    expect(out.isError).toBeFalsy();
    const records = structured(out).records as Array<{ fieldEcho: string[] }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.fieldEcho).toEqual(["path"]);
    }
  });

  // Phase 4 audit advisory: extract_evidence_context shares
  // emitPullEventsAndCommand + computePreviewAudit with search_evidence, so
  // the audit-row behavior is structurally symmetric. The three tests below
  // pin extract's audit row independently — protects against future drift
  // if either tool's handler diverges from the shared helper contract.

  it("extract_evidence_context commands.jsonl audit row: preview path carries Phase 4 fields", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const sc2 = structured(r2);
    const newRunId = sc2.runId as string;
    const runDir = sc2.runDir as string;

    await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId: newRunId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        beforeMs: 1000,
        afterMs: 2000,
        query: { source: "fake_src" },
      },
    });

    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const row = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"extract_evidence_context"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(row).toBeDefined();
    expect(row?.fullRecords).toBe(false);
    expect(row?.truncatedRecords).toBeGreaterThan(0);
    expect(row?.truncatedFullBytesSum).toBe((row?.truncatedRecords as number) * 9999);
    expect(row?.savedBytesSum).toBeGreaterThan(0);
    expect(row?.savedBytesSum).toBeLessThan(row?.truncatedFullBytesSum as number);
  });

  it("extract_evidence_context commands.jsonl audit row: fullRecords:true → sums all 0", async () => {
    const h = await harness();
    const { runId } = await startRun(h);
    writeProfileJson(h.projectRoot, PREVIEW_PROFILE_NAME);
    await h.client.callTool({ name: "android_debug_stop_session", arguments: { runId } });
    const r2 = await h.client.callTool({
      name: "android_debug_start_session",
      arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
    });
    const sc2 = structured(r2);
    const newRunId = sc2.runId as string;
    const runDir = sc2.runDir as string;

    await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId: newRunId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        beforeMs: 1000,
        afterMs: 2000,
        query: { source: "fake_src" },
        limit: 5,
        fullRecords: true,
      },
    });

    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const row = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"extract_evidence_context"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(row?.fullRecords).toBe(true);
    expect(row?.truncatedRecords).toBe(0);
    expect(row?.truncatedFullBytesSum).toBe(0);
    expect(row?.savedBytesSum).toBe(0);
  });

  it("extract_evidence_context commands.jsonl audit row: vanilla soft-empty still includes Phase 4 fields", async () => {
    const h = await harness();
    const { runId, runDir } = await startRun(h); // no profile → soft-empty
    await h.client.callTool({
      name: "android_debug_extract_evidence_context",
      arguments: {
        runId,
        markerIsoTs: new Date(1_716_600_000_500).toISOString(),
        query: { source: "fake_src" },
      },
    });
    const commandsText = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    const row = commandsText
      .split("\n")
      .filter((l) => l.includes('"tool":"extract_evidence_context"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .pop();
    expect(row?.softEmpty).toBe(true);
    expect(row?.fullRecords).toBe(false);
    expect(row?.truncatedRecords).toBe(0);
    expect(row?.truncatedFullBytesSum).toBe(0);
    expect(row?.savedBytesSum).toBe(0);
  });
});
