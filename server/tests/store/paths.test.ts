import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLocksRoot, resetPathsCache, resolveRunRoot } from "../../src/store/paths.ts";

const savedEnv = process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
let scratch = "";

describe("resolveRunRoot — 4-source resolution (§ C-3)", () => {
  beforeEach(() => {
    resetPathsCache();
    scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-paths-"));
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env unset, not the string "undefined".
      delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    } else {
      process.env.ANDROID_DEBUG_MCP_RUN_ROOT = savedEnv;
    }
    resetPathsCache();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("source=explicit when projectRoot arg is given", () => {
    // biome-ignore lint/performance/noDelete: ensure env doesn't shadow the explicit arg.
    delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    const { runRoot, source } = resolveRunRoot({ projectRoot: scratch, cwd: scratch });
    expect(source).toBe("explicit");
    expect(runRoot).toBe(join(scratch, ".android-debug-runs"));
  });

  it("source=env when ANDROID_DEBUG_MCP_RUN_ROOT is set and projectRoot is absent", () => {
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = join(scratch, "envroot");
    const { runRoot, source } = resolveRunRoot({ cwd: scratch });
    expect(source).toBe("env");
    expect(runRoot).toBe(join(scratch, "envroot"));
  });

  it("source=cwd-git when env is empty and cwd is inside a git checkout", () => {
    // biome-ignore lint/performance/noDelete: explicit absence of env.
    delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    // The repo itself is a git repo. cwd = process.cwd() picks it up.
    const { source, runRoot } = resolveRunRoot({ cwd: process.cwd() });
    expect(source).toBe("cwd-git");
    expect(runRoot.endsWith("/.android-debug-runs")).toBe(true);
  });

  it("source=fallback when neither projectRoot, env, nor git apply", () => {
    // biome-ignore lint/performance/noDelete: explicit absence of env.
    delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    // mkdtemp dir is not under any git tree we created, so git rev-parse fails.
    const { source, runRoot } = resolveRunRoot({ cwd: scratch });
    expect(source).toBe("fallback");
    expect(runRoot.endsWith(".android-debug-mcp/runs")).toBe(true);
  });
});

describe("getLocksRoot", () => {
  it("returns ~/.android-debug-mcp/locks and ensures the directory exists", () => {
    const path = getLocksRoot();
    expect(path.endsWith(".android-debug-mcp/locks")).toBe(true);
  });
});
