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
import { registerExtractEvidenceContext } from "../../src/mcp/tools/extract_evidence_context.ts";
import { registerSearchEvidence } from "../../src/mcp/tools/search_evidence.ts";
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

vi.mock("../../src/adb/app.ts", () => ({
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
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.shutdown();
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
  opts: { withProfile?: boolean } = {},
): Promise<{ runId: string; runDir: string }> {
  if (opts.withProfile === true) writeProfileJson(h.projectRoot, TEST_PROFILE_NAME);
  const r = await h.client.callTool({
    name: "android_debug_start_session",
    arguments: { packageName: "com.example.v2g_evidence", projectRoot: h.projectRoot },
  });
  const sc = structured(r);
  return { runId: sc.runId as string, runDir: sc.runDir as string };
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

    const eventsText = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(eventsText).toContain("evidence_pulled");
    expect(eventsText).toContain(`"source":"fake_src"`);
    expect(eventsText).toContain(`"trigger":"lazy"`);
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

describe("extract_evidence_context", () => {
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

  it("seal after a search_evidence: re-pulls (cache bypass) and emits one more event", async () => {
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
    expect(sealCount1).toBe(1);
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
  previewForAgent(record) {
    const r = record as unknown as FakeRecord;
    return {
      record: { ...r, path: "[preview]" } as unknown as ParsedRecord,
      truncated: true,
      fullSizeBytes: 9999,
      truncatedFields: ["path"],
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

  it("search_evidence fullRecords:true: records do NOT carry _meta (preview skipped)", async () => {
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
    const records = sc.records as Array<{ path: string; _meta?: unknown }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec._meta).toBeUndefined();
      expect(rec.path).not.toBe("[preview]"); // hook NOT called
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

  it("extract_evidence_context fullRecords:true: records do NOT carry _meta (symmetric with search_evidence)", async () => {
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
    const records = sc.records as Array<{ path: string; _meta?: unknown }>;
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec._meta).toBeUndefined();
      expect(rec.path).not.toBe("[preview]");
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
});
