import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run-index lives under `~/.android-debug-mcp/run-index/` in production. In
// tests, redirect it to a per-process tmp dir so test runs do not pollute
// the user's home and stale entries from one test cannot satisfy another
// test's "unknown runId → run_missing" assertion.
//
// vitest loads this file once per worker before any test module imports;
// `getRunIndexRoot()` reads the env at call time, so setting it here is
// sufficient.
if (!process.env.ANDROID_DEBUG_MCP_INDEX_ROOT) {
  process.env.ANDROID_DEBUG_MCP_INDEX_ROOT = mkdtempSync(join(tmpdir(), "adm-test-runidx-"));
}

// Lockfiles are host-global in production. In tests, redirect them to a
// per-process tmp dir so lock tests do not write into the user's home or pick
// up stale lock state from a previous run.
if (!process.env.ANDROID_DEBUG_MCP_LOCKS_ROOT) {
  process.env.ANDROID_DEBUG_MCP_LOCKS_ROOT = mkdtempSync(join(tmpdir(), "adm-test-locks-"));
}
