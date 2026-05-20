import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitInfo } from "../../src/host/git.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-git-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("getGitInfo", () => {
  it("returns a sha + dirty boolean inside this repository", () => {
    const info = getGitInfo(process.cwd());
    expect(info.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof info.dirty).toBe("boolean");
  });

  it("returns {sha:null, dirty:null} for a non-git directory", () => {
    expect(getGitInfo(scratch)).toEqual({ sha: null, dirty: null });
  });

  it("never throws on a nonexistent path", () => {
    expect(() => getGitInfo("/no/such/path/at/all")).not.toThrow();
    expect(getGitInfo("/no/such/path/at/all")).toEqual({ sha: null, dirty: null });
  });
});
