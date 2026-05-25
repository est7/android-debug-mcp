import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolDomainError } from "../../src/mcp/toolError.ts";
import { PROFILE_DIR, PROFILE_FILENAME, loadProfile } from "../../src/profile/loader.ts";

let scratch = "";

function writeProfile(content: string): string {
  mkdirSync(join(scratch, PROFILE_DIR), { recursive: true });
  const path = join(scratch, PROFILE_DIR, PROFILE_FILENAME);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-profile-loader-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("loadProfile — vanilla soft paths", () => {
  it("returns null when projectRoot is null (no source-tree resolved)", async () => {
    expect(await loadProfile(null)).toBeNull();
  });

  it("returns null when profile.json does not exist under projectRoot", async () => {
    // scratch dir has no .android-debug-mcp/profile.json
    expect(await loadProfile(scratch)).toBeNull();
  });
});

describe("loadProfile — happy path", () => {
  it("loads `poppo-vone` with version 1 into a built-in profile", async () => {
    writeProfile(JSON.stringify({ name: "poppo-vone", version: 1 }));
    const loaded = await loadProfile(scratch);
    expect(loaded).not.toBeNull();
    expect(loaded?.profile.name).toBe("poppo-vone");
    expect(loaded?.json).toEqual({ name: "poppo-vone", version: 1 });
    expect(loaded?.path).toMatch(/\.android-debug-mcp\/profile\.json$/);
  });

  it("ignores extra whitespace in the JSON file", async () => {
    writeProfile(`\n\n  ${JSON.stringify({ name: "poppo-vone", version: 1 })}  \n`);
    const loaded = await loadProfile(scratch);
    expect(loaded?.profile.name).toBe("poppo-vone");
  });
});

describe("loadProfile — hard error paths", () => {
  it("throws profile_malformed when JSON is invalid", async () => {
    writeProfile("{ not valid json");
    await expect(loadProfile(scratch)).rejects.toBeInstanceOf(ToolDomainError);
    try {
      await loadProfile(scratch);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolDomainError);
      expect((err as ToolDomainError).code).toBe("profile_malformed");
      expect((err as ToolDomainError).message).toContain("not valid JSON");
    }
  });

  it("throws profile_malformed when JSON parses but fails zod (.strict() rejects unknown keys)", async () => {
    writeProfile(JSON.stringify({ name: "poppo-vone", version: 1, overrides: { x: 1 } }));
    await expect(loadProfile(scratch)).rejects.toBeInstanceOf(ToolDomainError);
    try {
      await loadProfile(scratch);
    } catch (err) {
      expect((err as ToolDomainError).code).toBe("profile_malformed");
    }
  });

  it("throws profile_malformed when version is wrong literal (forward-compat anchor)", async () => {
    writeProfile(JSON.stringify({ name: "poppo-vone", version: 2 }));
    await expect(loadProfile(scratch)).rejects.toBeInstanceOf(ToolDomainError);
    try {
      await loadProfile(scratch);
    } catch (err) {
      expect((err as ToolDomainError).code).toBe("profile_malformed");
    }
  });

  it("throws profile_unknown when name does not match any built-in profile", async () => {
    writeProfile(JSON.stringify({ name: "future-app", version: 1 }));
    await expect(loadProfile(scratch)).rejects.toBeInstanceOf(ToolDomainError);
    try {
      await loadProfile(scratch);
    } catch (err) {
      expect((err as ToolDomainError).code).toBe("profile_unknown");
      const payload = (err as ToolDomainError).toPayload();
      expect(payload.error).toBe("profile_unknown");
      expect(payload.name).toBe("future-app");
      expect(payload.known).toEqual(expect.arrayContaining(["poppo-vone"]));
    }
  });

  it("throws profile_malformed when `name` is empty string (zod min(1))", async () => {
    writeProfile(JSON.stringify({ name: "", version: 1 }));
    await expect(loadProfile(scratch)).rejects.toBeInstanceOf(ToolDomainError);
    try {
      await loadProfile(scratch);
    } catch (err) {
      expect((err as ToolDomainError).code).toBe("profile_malformed");
    }
  });
});
