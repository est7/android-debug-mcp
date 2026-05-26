import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerCollectBundle } from "../../src/mcp/tools/collect_bundle.ts";
import { registerListRuns } from "../../src/mcp/tools/list_runs.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { writeMetadata } from "../../src/store/metadata.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

let runRoot = "";
const open: Array<{ shutdown(): Promise<void> }> = [];

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "run-mgmt-test", version: "0.0.0-test" });
  const manager = new SessionManager();
  registerListRuns(server, manager);
  registerCollectBundle(server, manager);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push({
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  });
  return client;
}

beforeEach(() => {
  runRoot = mkdtempSync(join(tmpdir(), "adm-runmgmt-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = runRoot;
  resetPathsCache();
});
afterEach(async () => {
  for (const h of open.splice(0)) await h.shutdown();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(runRoot, { recursive: true, force: true });
});

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}

/** Write a complete run folder directly on disk (no session needed). */
async function makeRun(pkg: string, runId: string, startedAt: string): Promise<void> {
  const runDir = join(runRoot, pkg, "u0", runId);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  await writeMetadata(runDir, {
    runId,
    deviceSerial: "SERIAL0",
    userId: 0,
    packageName: pkg,
    runRoot,
    runRootSource: "env",
    startedAt,
    closedAt: "2026-05-20T11:00:00.000Z",
    status: "stopped",
  });
  writeFileSync(join(runDir, "events.jsonl"), '{"type":"mark","ts":"T"}\n');
  writeFileSync(join(runDir, "commands.jsonl"), "");
  writeFileSync(join(runDir, "crash.jsonl"), "");
  writeFileSync(
    join(runDir, "logcat.jsonl"),
    `${JSON.stringify({ tsRaw: "05-20 10:00:00.000", message: "ok" })}\n`,
  );
}

describe("list_runs tool", () => {
  it("lists runs newest-first and paginates with a stable cursor", async () => {
    const client = await harness();
    await makeRun("com.a", "2026-05-20T10-00-00.000Z_r1", "2026-05-20T10:00:00.000Z");
    await makeRun("com.b", "2026-05-20T10-01-00.000Z_r2", "2026-05-20T10:01:00.000Z");
    await makeRun("com.c", "2026-05-20T10-02-00.000Z_r3", "2026-05-20T10:02:00.000Z");

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await client.callTool({
        name: "android_debug_list_runs",
        arguments: { limit: 2, ...(cursor ? { cursor } : {}) },
      });
      const sc = structured(r);
      collected.push(...(sc.runs as Array<{ runId: string }>).map((x) => x.runId));
      cursor = sc.nextCursor as string | undefined;
      expect(sc.totalCount).toBe(3);
      expect(++pages).toBeLessThan(6);
    } while (cursor !== undefined);

    // newest startedAt first, every run once.
    expect(collected).toEqual([
      "2026-05-20T10-02-00.000Z_r3",
      "2026-05-20T10-01-00.000Z_r2",
      "2026-05-20T10-00-00.000Z_r1",
    ]);
  });

  it("rejects a malformed cursor with invalid_cursor", async () => {
    const client = await harness();
    const r = await client.callTool({
      name: "android_debug_list_runs",
      arguments: { cursor: "not-a-cursor" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("invalid_cursor");
  });
});

describe("collect_bundle tool", () => {
  it("bundles a run (logs:none by default) and reports the archive path", async () => {
    const client = await harness();
    await makeRun("com.bundle", "2026-05-20T10-00-00.000Z_bnd", "2026-05-20T10:00:00.000Z");
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_bnd" },
    });
    expect(r.isError).toBeFalsy();
    const sc = structured(r);
    expect(sc.logs).toBe("none");
    expect(sc.byteSize as number).toBeGreaterThan(0);
    expect(existsSync(sc.bundlePath as string)).toBe(true);
  });

  it("rejects logs:raw without acknowledgeUnredacted (§ C-4 leak gate)", async () => {
    const client = await harness();
    await makeRun("com.bundle2", "2026-05-20T10-00-00.000Z_bn2", "2026-05-20T10:00:00.000Z");
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_bn2", logs: "raw" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("confirmation_required");
  });

  it("allows logs:raw when acknowledgeUnredacted is true", async () => {
    const client = await harness();
    await makeRun("com.bundle3", "2026-05-20T10-00-00.000Z_bn3", "2026-05-20T10:00:00.000Z");
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: {
        runId: "2026-05-20T10-00-00.000Z_bn3",
        logs: "raw",
        acknowledgeUnredacted: true,
      },
    });
    expect(r.isError).toBeFalsy();
    expect(structured(r).logs).toBe("raw");
  });

  it("returns run_missing for an unknown runId", async () => {
    const client = await harness();
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_nope" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(callText(r)).error).toBe("run_missing");
  });

  // --- v2-G Phase 5 (i): evidence_redaction_unavailable guard (codex β) ----

  /** Add an evidence/<sourceId>/ subdir to an existing run. */
  function addEvidenceDir(pkg: string, runId: string, sourceId: string): void {
    const runDir = join(runRoot, pkg, "u0", runId);
    const eDir = join(runDir, "evidence", sourceId);
    mkdirSync(eDir, { recursive: true });
    writeFileSync(join(eDir, "http_2026-05-26_0.jsonl"), "");
  }

  /** Patch a run's metadata.profile field. */
  async function patchProfile(
    pkg: string,
    runId: string,
    profile: { name: string; version: 1 } | null,
  ): Promise<void> {
    const runDir = join(runRoot, pkg, "u0", runId);
    const { readMetadata, writeMetadata } = await import("../../src/store/metadata.ts");
    const cur = await readMetadata(runDir);
    await writeMetadata(runDir, { ...cur, profile });
  }

  it("evidence_redaction_unavailable when profile is null but evidence/ dir exists", async () => {
    const client = await harness();
    await makeRun("com.bundle.evnull", "2026-05-20T10-00-00.000Z_ev1", "2026-05-20T10:00:00.000Z");
    addEvidenceDir("com.bundle.evnull", "2026-05-20T10-00-00.000Z_ev1", "poppo_http");
    // metadata.profile defaults to null in makeRun.
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_ev1" },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as {
      error: string;
      profileName: string | null;
      sourceId: string | null;
    };
    expect(err.error).toBe("evidence_redaction_unavailable");
    expect(err.profileName).toBeNull();
    expect(err.sourceId).toBe("poppo_http");
  });

  it("evidence_redaction_unavailable when metadata.profile names an unknown profile", async () => {
    const client = await harness();
    await makeRun("com.bundle.evx", "2026-05-20T10-00-00.000Z_ev2", "2026-05-20T10:00:00.000Z");
    addEvidenceDir("com.bundle.evx", "2026-05-20T10-00-00.000Z_ev2", "poppo_http");
    await patchProfile("com.bundle.evx", "2026-05-20T10-00-00.000Z_ev2", {
      name: "no-such-profile",
      version: 1,
    });
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_ev2" },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as { error: string; profileName: string };
    expect(err.error).toBe("evidence_redaction_unavailable");
    expect(err.profileName).toBe("no-such-profile");
  });

  it("evidence_redaction_unavailable when evidence dir's sourceId is not declared by the resolved profile", async () => {
    const client = await harness();
    await makeRun("com.bundle.evorf", "2026-05-20T10-00-00.000Z_ev3", "2026-05-20T10:00:00.000Z");
    // poppo-vone declares `poppo_http`; an evidence/orphan_src/ subdir is undeclared.
    addEvidenceDir("com.bundle.evorf", "2026-05-20T10-00-00.000Z_ev3", "orphan_src");
    await patchProfile("com.bundle.evorf", "2026-05-20T10-00-00.000Z_ev3", {
      name: "poppo-vone",
      version: 1,
    });
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_ev3" },
    });
    expect(r.isError).toBe(true);
    const err = JSON.parse(callText(r)) as {
      error: string;
      profileName: string;
      sourceId: string;
    };
    expect(err.error).toBe("evidence_redaction_unavailable");
    expect(err.profileName).toBe("poppo-vone");
    expect(err.sourceId).toBe("orphan_src");
  });

  it("vanilla run with profile null + NO evidence dir still bundles (no false-positive guard)", async () => {
    const client = await harness();
    await makeRun(
      "com.bundle.vanilla2",
      "2026-05-20T10-00-00.000Z_ev4",
      "2026-05-20T10:00:00.000Z",
    );
    // No evidence dir, no profile — should succeed as before.
    const r = await client.callTool({
      name: "android_debug_collect_bundle",
      arguments: { runId: "2026-05-20T10-00-00.000Z_ev4" },
    });
    expect(r.isError).toBeFalsy();
  });
});
