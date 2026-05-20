import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BundleLogs, createBundle } from "../../src/bundle/bundle.ts";

const exec = promisify(execFile);
const RUN_ID = "2026-05-20T10-00-00.000Z_bndl";

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "adm-bundle-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A run folder with one credential-bearing logcat line. */
function makeRunDir(): string {
  const runDir = join(workDir, RUN_ID);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), "{}");
  writeFileSync(join(runDir, "events.jsonl"), '{"type":"mark","ts":"T"}\n');
  writeFileSync(
    join(runDir, "logcat.jsonl"),
    `${JSON.stringify({ tsRaw: "05-20 10:00:00.000", message: "Authorization: Basic c2VjcmV0" })}\n`,
  );
  writeFileSync(join(runDir, "logcat.raw.txt"), "raw byte log line\n");
  writeFileSync(join(runDir, "artifacts", `screenshot-${RUN_ID}.png`), "PNGDATA");
  return runDir;
}

async function bundleEntries(bundlePath: string): Promise<string[]> {
  const { stdout } = await exec("tar", ["-tzf", bundlePath]);
  return stdout.trim().split("\n");
}

async function build(logs: BundleLogs): Promise<{ entries: string[]; bundlePath: string }> {
  const result = await createBundle({
    runDir: makeRunDir(),
    runId: RUN_ID,
    bundlesDir: join(workDir, "bundles"),
    logs,
  });
  expect(result.byteSize).toBeGreaterThan(0);
  expect(result.bundlePath).toContain(`bundle-${RUN_ID}.tar.gz`);
  return { entries: await bundleEntries(result.bundlePath), bundlePath: result.bundlePath };
}

describe("createBundle logs policy (§ C-4)", () => {
  it("`none` omits both logcat files but keeps the rest", async () => {
    const { entries } = await build("none");
    expect(entries.some((e) => e.endsWith("metadata.json"))).toBe(true);
    expect(entries.some((e) => e.endsWith("events.jsonl"))).toBe(true);
    expect(entries.some((e) => e.endsWith(".png"))).toBe(true);
    expect(entries.some((e) => e.endsWith("logcat.jsonl"))).toBe(false);
    expect(entries.some((e) => e.endsWith("logcat.raw.txt"))).toBe(false);
    expect(entries.some((e) => e.endsWith("logcat.redacted.jsonl"))).toBe(false);
  });

  it("`raw` includes logcat.jsonl and logcat.raw.txt verbatim", async () => {
    const { entries } = await build("raw");
    expect(entries.some((e) => e.endsWith("logcat.jsonl"))).toBe(true);
    expect(entries.some((e) => e.endsWith("logcat.raw.txt"))).toBe(true);
  });

  it("`redacted` ships logcat.redacted.jsonl with credentials scrubbed, no raw", async () => {
    const { entries, bundlePath } = await build("redacted");
    expect(entries.some((e) => e.endsWith("logcat.redacted.jsonl"))).toBe(true);
    expect(entries.some((e) => e.endsWith("logcat.jsonl"))).toBe(false);
    expect(entries.some((e) => e.endsWith("logcat.raw.txt"))).toBe(false);

    // Extract and confirm the Authorization value was blanked.
    const extractDir = join(workDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    await exec("tar", ["-xzf", bundlePath, "-C", extractDir]);
    const redacted = readFileSync(join(extractDir, RUN_ID, "logcat.redacted.jsonl"), "utf8");
    expect(redacted).not.toContain("c2VjcmV0");
    expect(JSON.parse(redacted.trim()).message).toBe("Authorization: ***");
  });
});
