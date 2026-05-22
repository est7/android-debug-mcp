import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  METADATA_FILENAME,
  type MetadataInput,
  patchMetadata,
  readMetadata,
  writeMetadata,
} from "../../src/store/metadata.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-meta-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function minimal(): MetadataInput {
  return {
    runId: "2026-05-19T10-15-49.821Z_aB3k",
    deviceSerial: "TESTDEV1",
    userId: 0,
    packageName: "com.example.app",
    runRoot: "/tmp/runs",
    runRootSource: "fallback",
    startedAt: "2026-05-19T10:15:49.821Z",
    status: "active",
  };
}

describe("metadata schema + IO", () => {
  it("round-trips a minimal metadata through write + read with defaults filled", async () => {
    const written = await writeMetadata(scratch, minimal());
    expect(written.closedAt).toBeNull();
    expect(written.bytesRead).toBe(0);
    expect(written.linesParsed).toBe(0);
    expect(written.crashFound).toBe(false);
    expect(written.app).toEqual({ versionName: null, versionCode: null });
    const read = await readMetadata(scratch);
    expect(read).toEqual(written);
  });

  it("rejects unknown top-level keys (strict schema)", async () => {
    const bad = { ...minimal(), bogus: "should be rejected" } as unknown as MetadataInput;
    await expect(writeMetadata(scratch, bad)).rejects.toThrow();
  });

  it("patchMetadata applies a partial update atomically", async () => {
    await writeMetadata(scratch, minimal());
    const patched = await patchMetadata(scratch, (cur) => ({
      ...cur,
      status: "stopped",
      closedAt: "2026-05-19T10:30:00.000Z",
      exitCode: 0,
      bytesRead: 4096,
      linesParsed: 17,
      crashFound: false,
    }));
    expect(patched.status).toBe("stopped");
    expect(patched.closedAt).toBe("2026-05-19T10:30:00.000Z");
    expect(patched.bytesRead).toBe(4096);
    expect(patched.linesParsed).toBe(17);
    const reread = await readMetadata(scratch);
    expect(reread).toEqual(patched);
  });

  it("reads a pre-v2-A metadata.json (no projectRoot key) as projectRoot:null", async () => {
    // A run written before Phase 2.0 simply lacks the key; the additive
    // `.default(null)` must read it back without a schema migration.
    writeFileSync(join(scratch, METADATA_FILENAME), JSON.stringify(minimal()));
    const read = await readMetadata(scratch);
    expect(read.projectRoot).toBeNull();
  });

  it("round-trips an explicit projectRoot through write + read", async () => {
    const written = await writeMetadata(scratch, {
      ...minimal(),
      projectRoot: "/Users/est9/AndroidStudioProjects/submodulepoppo",
    });
    expect(written.projectRoot).toBe("/Users/est9/AndroidStudioProjects/submodulepoppo");
    expect((await readMetadata(scratch)).projectRoot).toBe(
      "/Users/est9/AndroidStudioProjects/submodulepoppo",
    );
  });

  it("writeMetadata produces pretty-printed JSON ending in newline", async () => {
    await writeMetadata(scratch, minimal());
    const text = readFileSync(join(scratch, METADATA_FILENAME), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"runId":');
    expect(text.split("\n").length).toBeGreaterThan(5);
  });
});
