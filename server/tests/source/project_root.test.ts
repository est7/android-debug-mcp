import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectRootMissingError } from "../../src/source/errors.ts";
import { requireRunProjectRoot } from "../../src/source/project_root.ts";
import { METADATA_FILENAME, type MetadataInput, writeMetadata } from "../../src/store/metadata.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-projmeta-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function baseMetadata(): MetadataInput {
  return {
    runId: "2026-05-22T10-00-00.000Z_aB3k",
    deviceSerial: "TESTDEV1",
    userId: 0,
    packageName: "com.example.app",
    runRoot: "/tmp/runs",
    runRootSource: "fallback",
    startedAt: "2026-05-22T10:00:00.000Z",
    status: "active",
  };
}

describe("requireRunProjectRoot", () => {
  it("returns the projectRoot recorded in metadata.json", async () => {
    await writeMetadata(scratch, {
      ...baseMetadata(),
      projectRoot: "/Users/est9/AndroidStudioProjects/submodulepoppo",
    });
    expect(await requireRunProjectRoot(scratch)).toBe(
      "/Users/est9/AndroidStudioProjects/submodulepoppo",
    );
  });

  it("throws ProjectRootMissingError when projectRoot is null", async () => {
    await writeMetadata(scratch, baseMetadata()); // projectRoot defaults to null
    await expect(requireRunProjectRoot(scratch)).rejects.toBeInstanceOf(ProjectRootMissingError);
  });

  it("throws ProjectRootMissingError for a pre-v2-A run (no projectRoot key on disk)", async () => {
    writeFileSync(join(scratch, METADATA_FILENAME), JSON.stringify(baseMetadata()));
    await expect(requireRunProjectRoot(scratch)).rejects.toBeInstanceOf(ProjectRootMissingError);
  });
});
