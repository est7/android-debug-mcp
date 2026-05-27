import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/session/manager.ts";
import { resolveRunDir } from "../../src/store/locate.ts";
import { resetPathsCache } from "../../src/store/paths.ts";
import { createRunDir } from "../../src/store/run.ts";
import { getRunIndexRoot } from "../../src/store/runIndex.ts";

let rootA = "";
let rootB = "";
let scratchIndex = "";
let savedIndexRoot: string | undefined;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), "adm-locate-rootA-"));
  rootB = mkdtempSync(join(tmpdir(), "adm-locate-rootB-"));
  scratchIndex = mkdtempSync(join(tmpdir(), "adm-locate-runidx-"));
  savedIndexRoot = process.env.ANDROID_DEBUG_MCP_INDEX_ROOT;
  process.env.ANDROID_DEBUG_MCP_INDEX_ROOT = scratchIndex;
  resetPathsCache();
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: must unset, not set to undefined.
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  if (savedIndexRoot === undefined) {
    // biome-ignore lint/performance/noDelete: must unset, not set to undefined.
    delete process.env.ANDROID_DEBUG_MCP_INDEX_ROOT;
  } else {
    process.env.ANDROID_DEBUG_MCP_INDEX_ROOT = savedIndexRoot;
  }
  resetPathsCache();
  for (const dir of [rootA, rootB, scratchIndex]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(runRoot: string, runId: string) {
  return {
    runRoot,
    runRootSource: "explicit" as const,
    projectRoot: null as string | null,
    packageName: "com.example.app",
    userId: 0,
    runId,
    deviceSerial: "TESTDEV1",
    startedAt: new Date("2026-05-27T10:15:49.821Z"),
  };
}

describe("resolveRunDir cross-runRoot lookup via run-index", () => {
  it("finds a run created under runRoot A when current runRoot resolves to B (the S6 acceptance hit)", async () => {
    const runId = "2026-05-27T10-15-49.821Z_xrA1";
    const folder = await createRunDir(fixture(rootA, runId));
    await folder.closeStreams();

    // Simulate: a later tool call runs from a process whose runRoot resolves
    // to B (different cwd, different env, different git toplevel).
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = rootB;
    resetPathsCache();

    const resolved = await resolveRunDir(new SessionManager(), runId);
    expect(resolved).toBe(folder.runDir);
  });

  it("falls back to runRoot scan when no index entry exists (backward-compat for pre-feature runs)", async () => {
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = rootA;
    resetPathsCache();
    const runId = "2026-05-27T10-15-49.821Z_xrB2";
    const folder = await createRunDir(fixture(rootA, runId));
    await folder.closeStreams();

    // Wipe the index entry so this run resembles one created before the
    // feature existed. Scan must still find it (same runRoot).
    rmSync(scratchIndex, { recursive: true, force: true });

    const resolved = await resolveRunDir(new SessionManager(), runId);
    expect(resolved).toBe(folder.runDir);
  });

  it("returns run_missing when neither index nor scan finds the run", async () => {
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = rootA;
    resetPathsCache();
    await expect(
      resolveRunDir(new SessionManager(), "2026-05-27T10-15-49.821Z_zzzz"),
    ).rejects.toMatchObject({ name: "ToolDomainError", code: "run_missing" });
  });

  it("ignores a dangling index entry and falls back to scan (which also misses → run_missing)", async () => {
    const runId = "2026-05-27T10-15-49.821Z_xrC3";
    const folder = await createRunDir(fixture(rootA, runId));
    await folder.closeStreams();

    // Delete the runDir but leave the symlink dangling.
    rmSync(folder.runDir, { recursive: true, force: true });

    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = rootB;
    resetPathsCache();

    await expect(resolveRunDir(new SessionManager(), runId)).rejects.toMatchObject({
      code: "run_missing",
    });
  });

  it("a polluted index entry (points at a different run's dir) is rejected → run_missing (codex STOP regression)", async () => {
    // Materialize a valid run owned by `otherRunId`. Then plant a manual
    // index entry under `askedRunId` pointing at that run's dir. The lookup
    // for `askedRunId` MUST reject the entry (runId mismatch), fall through
    // to scan (which only knows the current runRoot — also a miss because
    // we point it at rootB), and surface run_missing rather than serve
    // otherRunId's dir.
    const askedRunId = "2026-05-27T10-15-49.821Z_askE";
    const otherRunId = "2026-05-27T10-15-49.821Z_othE";
    const folder = await createRunDir(fixture(rootA, otherRunId));
    await folder.closeStreams();
    mkdirSync(getRunIndexRoot(), { recursive: true });
    symlinkSync(folder.runDir, join(getRunIndexRoot(), askedRunId));

    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = rootB;
    resetPathsCache();

    await expect(resolveRunDir(new SessionManager(), askedRunId)).rejects.toMatchObject({
      code: "run_missing",
    });
  });

  it("prefers an active session over the index even when both could resolve", async () => {
    const runId = "2026-05-27T10-15-49.821Z_xrD4";
    const folder = await createRunDir(fixture(rootA, runId));
    await folder.closeStreams();

    const manager = new SessionManager();
    const fakeSession = {
      runId,
      runDir: "/some/other/path/that/wins",
    } as unknown as ReturnType<SessionManager["listActive"]>[number];
    const spy = vi.spyOn(manager, "listActive").mockReturnValue([fakeSession]);
    try {
      const resolved = await resolveRunDir(manager, runId);
      expect(resolved).toBe("/some/other/path/that/wins");
    } finally {
      spy.mockRestore();
    }
  });
});
