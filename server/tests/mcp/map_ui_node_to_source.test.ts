import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMapUiNodeToSource } from "../../src/mcp/tools/map_ui_node_to_source.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { SearchTimedOutError } from "../../src/source/errors.ts";
import { resetRgPathCache } from "../../src/source/rg.ts";
import { resetPathsCache } from "../../src/store/paths.ts";
import { createRunDir } from "../../src/store/run.ts";
import { mintRunId } from "../../src/store/runId.ts";
import { materializeSourceFixture } from "../fixtures/source/build_fixture.ts";

// `resolveCandidates` is a spy that call-throughs to the real recipe by
// default — only the timeout test overrides it (a real rg timeout cannot be
// forced cheaply through the tool's fixed input).
vi.mock("../../src/source/recipe.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/source/recipe.ts")>();
  return { ...actual, resolveCandidates: vi.fn(actual.resolveCandidates) };
});
import { resolveCandidates } from "../../src/source/recipe.ts";

const PKG = "com.example.poppo";
const savedRgPath = process.env.RG_PATH;
let scratch = "";
let fixtureRoot = "";

interface OpenHarness {
  client: Client;
  shutdown(): Promise<void>;
}
const openHarnesses: OpenHarness[] = [];

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "map-test", version: "0.0.0-test" });
  registerMapUiNodeToSource(server, new SessionManager());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openHarnesses.push({
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  });
  return client;
}

beforeEach(() => {
  vi.clearAllMocks(); // reset resolveCandidates call history (impl is preserved)
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-map-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
  resetRgPathCache();
  fixtureRoot = mkdtempSync(join(tmpdir(), "android-debug-mcp-mapsrc-"));
  materializeSourceFixture(fixtureRoot);
});

afterEach(async () => {
  for (const h of openHarnesses.splice(0)) await h.shutdown();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  if (savedRgPath === undefined) {
    // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
    delete process.env.RG_PATH;
  } else {
    process.env.RG_PATH = savedRgPath;
  }
  resetPathsCache();
  resetRgPathCache();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** Materialize a run folder on disk so `resolveRunDir` finds it (no live session). */
async function makeRun(projectRoot: string | null): Promise<{ runId: string; runDir: string }> {
  const runId = mintRunId();
  const folder = await createRunDir({
    runRoot: scratch,
    runRootSource: "env",
    projectRoot,
    packageName: PKG,
    userId: 0,
    runId,
    deviceSerial: "TESTDEV-MAP",
    startedAt: new Date("2026-05-22T10:00:00.000Z"),
  });
  await folder.closeStreams();
  return { runId, runDir: folder.runDir };
}

function node(resourceId: string | null): Record<string, unknown> {
  return {
    resourceId,
    class: "android.widget.Button",
    package: PKG,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    index: 0,
    clickable: true,
    focusable: false,
  };
}

function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function callMap(client: Client, args: Record<string, unknown>): Promise<unknown> {
  return client.callTool({ name: "android_debug_map_ui_node_to_source", arguments: args });
}

describe("map_ui_node_to_source — happy path", () => {
  it("maps a tapped id to high confidence and appends a source_mapping event", async () => {
    const { runId, runDir } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: `${PKG}/.LoginActivity`,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBeFalsy();
    const sc = structured(result);
    expect(sc.confidence).toBe("high");
    expect(Array.isArray(sc.candidates) && sc.candidates.length).toBeGreaterThan(0);
    expect(Array.isArray(sc.signals)).toBe(true);

    // The call is recorded: a source_mapping event + rg command lines.
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"source_mapping"');
    const commands = readFileSync(join(runDir, "commands.jsonl"), "utf8");
    expect(commands).toContain("map_ui_node_to_source");
  });

  it("keeps candidates when minConfidence is satisfied", async () => {
    const { runId } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: `${PKG}/.LoginActivity`,
      ancestorChain: [],
      minConfidence: "high",
    });
    const sc = structured(result);
    expect(sc.confidence).toBe("high");
    expect(Array.isArray(sc.candidates) && sc.candidates.length).toBeGreaterThan(0);
    expect(sc.warnings).toBeUndefined();
  });

  it("filters candidates with a warning when minConfidence is not satisfied", async () => {
    const { runId, runDir } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: `${PKG}/.LoginActivity`,
      ancestorChain: [
        {
          ...node(`${PKG}:id/recycler_parent`),
          class: "androidx.recyclerview.widget.RecyclerView",
        },
      ],
      minConfidence: "medium",
    });
    const sc = structured(result);
    expect(sc.confidence).toBe("low");
    expect(sc.candidates).toEqual([]);
    expect(sc.warnings).toEqual(["confidence_below_min"]);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"warnings":["confidence_below_min"]');
    expect(events).toContain('"minConfidence":"medium"');
  });

  it("caps candidates with top after the confidence gate passes", async () => {
    const { runId } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: `${PKG}/.LoginActivity`,
      ancestorChain: [],
      minConfidence: "medium",
      top: 1,
    });
    const sc = structured(result);
    expect(sc.confidence).toBe("high");
    expect(sc.candidates).toEqual([
      {
        file: "app/src/main/res/layout/activity_login.xml",
        line: 6,
        kind: "id_declaration",
        text: 'android:id="@+id/login_button"',
      },
    ]);
    expect(sc.warnings).toBeUndefined();
  });

  it("returns a soft none result with no search when anchorNode is null", async () => {
    const { runId } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: null,
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBeFalsy();
    expect(structured(result).confidence).toBe("none");
    expect(structured(result).candidates).toEqual([]);
    expect(vi.mocked(resolveCandidates)).not.toHaveBeenCalled();
  });

  it("returns a soft none result when rg finds the id nowhere", async () => {
    const { runId } = await makeRun(fixtureRoot);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/totally_absent_id`),
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBeFalsy();
    expect(structured(result).confidence).toBe("none");
    expect(structured(result).candidates).toEqual([]);
  });

  it("returns soft none for a null anchor even when the run has no projectRoot", async () => {
    // A no-anchor tap needs no rg search, so it must not depend on a source
    // root — projectRoot:null yields a soft none, not project_root_missing.
    const { runId } = await makeRun(null);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: null,
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBeFalsy();
    expect(structured(result).confidence).toBe("none");
    expect(structured(result).candidates).toEqual([]);
  });

  it("returns soft none for a framework anchor even when the run has no projectRoot", async () => {
    const { runId } = await makeRun(null);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node("android:id/text1"),
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBeFalsy();
    expect(structured(result).confidence).toBe("none");
  });
});

describe("map_ui_node_to_source — hard errors (design lock Q9)", () => {
  it("run_missing for an unknown runId", async () => {
    const client = await harness();
    const result = await callMap(client, {
      runId: "no-such-run-id",
      anchorNode: null,
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("run_missing");
  });

  it("project_root_missing when the run was started outside a git checkout", async () => {
    const { runId } = await makeRun(null);
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("project_root_missing");
  });

  it("rg_not_found when the ripgrep binary cannot be resolved", async () => {
    const { runId } = await makeRun(fixtureRoot);
    process.env.RG_PATH = join(scratch, "no-such-rg-binary");
    resetRgPathCache();
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("rg_not_found");
  });

  it("search_timed_out, and writes no source_mapping event", async () => {
    const { runId, runDir } = await makeRun(fixtureRoot);
    vi.mocked(resolveCandidates).mockRejectedValueOnce(new SearchTimedOutError(10_000));
    const client = await harness();
    const result = await callMap(client, {
      runId,
      anchorNode: node(`${PKG}:id/login_button`),
      foregroundActivity: null,
      ancestorChain: [],
    });
    expect((result as { isError?: unknown }).isError).toBe(true);
    expect(JSON.parse(callText(result)).error).toBe("search_timed_out");
    // A timed-out search is abandoned whole — no partial result is recorded.
    expect(readFileSync(join(runDir, "events.jsonl"), "utf8")).toBe("");
  });
});
