import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MetadataInput, writeMetadata } from "../../src/store/metadata.ts";
import {
  getRunIndexRoot,
  readRunIndex,
  removeRunIndex,
  writeRunIndex,
} from "../../src/store/runIndex.ts";

// `server/tests/setup.ts` redirects ANDROID_DEBUG_MCP_INDEX_ROOT to a
// per-process tmp dir, so writes here go to a hermetic location. We point
// it at a fresh dir per test for extra isolation, then restore on teardown.
let scratch = "";
let scratchIndex = "";
let savedIndexRoot: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-runidx-test-"));
  scratchIndex = mkdtempSync(join(tmpdir(), "adm-runidx-root-"));
  savedIndexRoot = process.env.ANDROID_DEBUG_MCP_INDEX_ROOT;
  process.env.ANDROID_DEBUG_MCP_INDEX_ROOT = scratchIndex;
});

afterEach(() => {
  if (savedIndexRoot === undefined) {
    // biome-ignore lint/performance/noDelete: must unset, not set to undefined.
    delete process.env.ANDROID_DEBUG_MCP_INDEX_ROOT;
  } else {
    process.env.ANDROID_DEBUG_MCP_INDEX_ROOT = savedIndexRoot;
  }
  for (const dir of [scratch, scratchIndex]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const RUN_ID = "2026-05-27T10-15-49.821Z_aB3k";

/** Materialize a run dir with a real metadata.json whose `runId` matches. */
async function makeRunDir(parent: string, label: string, metadataRunId: string): Promise<string> {
  const runDir = join(parent, label);
  mkdirSync(runDir, { recursive: true });
  const input: MetadataInput = {
    runId: metadataRunId,
    deviceSerial: "TESTDEV1",
    userId: 0,
    packageName: "com.example.app",
    runRoot: parent,
    runRootSource: "fallback",
    startedAt: "2026-05-27T10:15:49.821Z",
    status: "stopped",
    closedAt: "2026-05-27T11:00:00.000Z",
  };
  await writeMetadata(runDir, input);
  return runDir;
}

describe("writeRunIndex + readRunIndex", () => {
  it("round-trips: write then read returns the absolute runDir", async () => {
    const runDir = await makeRunDir(scratch, "the-run", RUN_ID);
    await writeRunIndex(RUN_ID, runDir);
    expect(await readRunIndex(RUN_ID)).toBe(runDir);
  });

  it("returns null when the runId has never been registered", async () => {
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("returns null when the symlink target has been deleted (dangling)", async () => {
    const runDir = await makeRunDir(scratch, "soon-gone", RUN_ID);
    await writeRunIndex(RUN_ID, runDir);
    rmSync(runDir, { recursive: true, force: true });
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("returns null when the target dir exists but has no metadata.json", async () => {
    const bare = join(scratch, "no-meta");
    mkdirSync(bare, { recursive: true });
    await writeRunIndex(RUN_ID, bare);
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("returns null when the target dir has an unparseable metadata.json", async () => {
    const bare = join(scratch, "bad-meta");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "metadata.json"), "{ not valid json");
    await writeRunIndex(RUN_ID, bare);
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("returns null when the symlink target is a file, not a directory", async () => {
    const filePath = join(scratch, "i-am-a-file");
    writeFileSync(filePath, "");
    await writeRunIndex(RUN_ID, filePath);
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("rejects cross-runId pollution: <index>/<askedRunId> → runDir whose metadata.runId is a DIFFERENT runId resolves to null (codex STOP regression)", async () => {
    const askedRunId = "2026-05-27T10-15-49.821Z_ask1";
    const otherRunId = "2026-05-27T10-15-49.821Z_oth2";
    // Build a runDir whose metadata declares it owns `otherRunId`, then
    // mis-plant the index entry for `askedRunId` pointing at that dir.
    const otherDir = await makeRunDir(scratch, "other-run", otherRunId);
    mkdirSync(getRunIndexRoot(), { recursive: true });
    symlinkSync(otherDir, join(getRunIndexRoot(), askedRunId));
    expect(await readRunIndex(askedRunId)).toBeNull();
    // Sanity: the metadata IS valid — null is purely because the runIds disagree.
    expect(await readRunIndex(otherRunId)).toBeNull(); // no index entry for otherRunId
  });

  it("auto-creates the index root on first write", async () => {
    rmSync(getRunIndexRoot(), { recursive: true, force: true });
    const runDir = await makeRunDir(scratch, "first-write", RUN_ID);
    await writeRunIndex(RUN_ID, runDir);
    expect(await readRunIndex(RUN_ID)).toBe(runDir);
  });

  it("is idempotent: a second write with a different target overwrites", async () => {
    const first = await makeRunDir(scratch, "first", RUN_ID);
    const second = await makeRunDir(scratch, "second", RUN_ID);
    await writeRunIndex(RUN_ID, first);
    await writeRunIndex(RUN_ID, second);
    expect(await readRunIndex(RUN_ID)).toBe(second);
  });

  it("resolves a relative symlink target against the index root before checking it", async () => {
    // writeRunIndex always passes absolute, but readRunIndex must tolerate
    // a hand-crafted relative entry (e.g. someone symlinks by hand for ops).
    const runDir = await makeRunDir(getRunIndexRoot(), "rel-target", RUN_ID);
    symlinkSync("./rel-target", join(getRunIndexRoot(), RUN_ID));
    expect(await readRunIndex(RUN_ID)).toBe(runDir);
  });

  it("writeRunIndex rejects an unsafe runId, readRunIndex tolerates it as 'no entry'", async () => {
    // writeRunIndex is called from createRunDir where input is already valid;
    // a malformed runId here is a programmer error and must throw.
    await expect(writeRunIndex("../escape", "/tmp")).rejects.toThrow();
    // readRunIndex is called from resolveRunDir which accepts any agent-supplied
    // string and maps unknown → run_missing; a malformed runId must therefore
    // resolve to null (no entry) rather than throw and break the contract.
    expect(await readRunIndex("../escape")).toBeNull();
    expect(await readRunIndex("no-such-run")).toBeNull();
  });

  it("writes 100 distinct runIds without collision", async () => {
    const pairs: [string, string][] = [];
    for (let i = 0; i < 100; i++) {
      const runId = `2026-05-27T10-15-49.821Z_a${String(i).padStart(3, "0")}`;
      const runDir = await makeRunDir(scratch, `run-${i}`, runId);
      pairs.push([runId, runDir]);
    }
    await Promise.all(pairs.map(([id, dir]) => writeRunIndex(id, dir)));
    for (const [id, dir] of pairs) {
      expect(await readRunIndex(id)).toBe(dir);
    }
  });
});

describe("removeRunIndex", () => {
  it("removes a present entry", async () => {
    const runDir = await makeRunDir(scratch, "doomed", RUN_ID);
    await writeRunIndex(RUN_ID, runDir);
    await removeRunIndex(RUN_ID);
    expect(await readRunIndex(RUN_ID)).toBeNull();
  });

  it("is a no-op for an absent entry", async () => {
    await expect(removeRunIndex(RUN_ID)).resolves.toBeUndefined();
  });
});
