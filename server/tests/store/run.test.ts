import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_JSONL_NAMES, createRunDir, runExists, runPath } from "../../src/store/run.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-run-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(overrides: Partial<Parameters<typeof createRunDir>[0]> = {}) {
  return {
    runRoot: scratch,
    runRootSource: "fallback" as const,
    projectRoot: null as string | null,
    packageName: "com.example.app",
    userId: 0,
    runId: "2026-05-19T10-15-49.821Z_aB3k",
    deviceSerial: "TESTDEV1",
    startedAt: new Date("2026-05-19T10:15:49.821Z"),
    ...overrides,
  };
}

describe("createRunDir + runPath", () => {
  it("materializes <runRoot>/<package>/u<userId>/<runId>/{artifacts,jsonl streams,metadata.json}", async () => {
    const folder = await createRunDir(fixture());
    const expected = join(scratch, "com.example.app", "u0", "2026-05-19T10-15-49.821Z_aB3k");
    expect(folder.runDir).toBe(expected);
    expect(statSync(folder.artifactsDir).isDirectory()).toBe(true);
    expect(statSync(join(folder.runDir, "metadata.json")).isFile()).toBe(true);
    for (const name of RUN_JSONL_NAMES) {
      const p = join(folder.runDir, `${name}.jsonl`);
      expect(statSync(p).isFile()).toBe(true);
      expect(readFileSync(p, "utf8")).toBe("");
    }
    await folder.closeStreams();
  });

  it("seeds metadata with status=active and the resolved runRoot source", async () => {
    const folder = await createRunDir(fixture({ runRootSource: "explicit" }));
    expect(folder.metadata.status).toBe("active");
    expect(folder.metadata.runRoot).toBe(scratch);
    expect(folder.metadata.runRootSource).toBe("explicit");
    expect(folder.metadata.closedAt).toBeNull();
    expect(folder.metadata.crashFound).toBe(false);
    await folder.closeStreams();
  });

  it("seeds metadata.projectRoot from the resolved source root", async () => {
    const withRoot = await createRunDir(fixture({ projectRoot: "/repo/poppo" }));
    expect(withRoot.metadata.projectRoot).toBe("/repo/poppo");
    await withRoot.closeStreams();
    // The fixture default is null (host not in a git checkout).
    const withoutRoot = await createRunDir(fixture({ runId: "2026-05-19T10-17-00.000Z_BBBB" }));
    expect(withoutRoot.metadata.projectRoot).toBeNull();
    await withoutRoot.closeStreams();
  });

  it("isolates work-profile userId paths from primary userId", async () => {
    const u0 = await createRunDir(fixture({ userId: 0 }));
    const u10 = await createRunDir(fixture({ userId: 10, runId: "2026-05-19T10-16-00.000Z_AAAA" }));
    expect(u0.runDir).toContain("/u0/");
    expect(u10.runDir).toContain("/u10/");
    expect(u0.runDir).not.toBe(u10.runDir);
    await u0.closeStreams();
    await u10.closeStreams();
  });

  it("runExists distinguishes existing run dirs from absent ones", async () => {
    expect(await runExists(fixture())).toBe(false);
    const folder = await createRunDir(fixture());
    expect(await runExists(fixture())).toBe(true);
    await folder.closeStreams();
  });

  it("closeStreams() is idempotent", async () => {
    const folder = await createRunDir(fixture());
    await folder.closeStreams();
    await expect(folder.closeStreams()).resolves.toBeUndefined();
  });

  it("streams accept writes after createRunDir and end up in the right files", async () => {
    const folder = await createRunDir(fixture());
    await folder.streams.events.append({ type: "test", n: 1 });
    await folder.streams.commands.append({ cmd: "tap", x: 10 });
    await folder.closeStreams();
    const events = readFileSync(join(folder.runDir, "events.jsonl"), "utf8").trim().split("\n");
    const commands = readFileSync(join(folder.runDir, "commands.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(events[0] as string)).toMatchObject({ type: "test", n: 1 });
    expect(JSON.parse(commands[0] as string)).toMatchObject({ cmd: "tap", x: 10 });
  });

  it("runPath is pure: no filesystem effects", () => {
    const p = runPath(fixture());
    expect(p).toBe(join(scratch, "com.example.app", "u0", "2026-05-19T10-15-49.821Z_aB3k"));
  });
});
