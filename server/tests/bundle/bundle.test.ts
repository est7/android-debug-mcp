import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BundleLogs, createBundle } from "../../src/bundle/bundle.ts";
import { POPPO_VONE_PROFILE } from "../../src/profile/poppo-vone/index.ts";

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
    profile: null, // existing tests use vanilla runs (no evidence/ dirs)
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

  it("omits macOS AppleDouble metadata files from the archive", async () => {
    const runDir = makeRunDir();
    writeFileSync(join(runDir, "._metadata.json"), "appledouble");
    writeFileSync(join(runDir, "artifacts", "._screenshot.png"), "appledouble");
    writeFileSync(join(runDir, ".DS_Store"), "finder");

    const previous = process.env.COPYFILE_DISABLE;
    process.env.COPYFILE_DISABLE = "1";
    let bundlePath = "";
    try {
      const result = await createBundle({
        runDir,
        runId: RUN_ID,
        bundlesDir: join(workDir, "bundles"),
        logs: "none",
        profile: null,
      });
      bundlePath = result.bundlePath;
    } finally {
      if (previous === undefined) {
        // biome-ignore lint/performance/noDelete: must restore absence, not the string "undefined".
        delete process.env.COPYFILE_DISABLE;
      } else {
        process.env.COPYFILE_DISABLE = previous;
      }
    }

    const entries = await bundleEntries(bundlePath);
    expect(entries.some((e) => e.split("/").some((part) => part.startsWith("._")))).toBe(false);
    expect(entries.some((e) => e.endsWith(".DS_Store"))).toBe(false);
    expect(existsSync(join(runDir, "._metadata.json"))).toBe(true);
    expect(existsSync(join(runDir, ".DS_Store"))).toBe(true);
  });
});

// --- v2-G Phase 5 (i): evidence redaction at bundle export ------------------

/**
 * Build a poppo_http evidence record JSONL line. Mirrors the rev4 schema's
 * shape; the bundle test only needs enough surface for `parseLine` to accept
 * it and `redactForBundle` to mask `Authorization` + `_sign`.
 */
function poppoRecord(opts: {
  seq: number;
  url: string;
  authValue?: string;
  /** When set, includes a parse-null sentinel line in the file before this record. */
  withGarbageLine?: boolean;
  /** When set, the response body's `text` field is padded to ~`bodyTextBytes` chars. */
  bodyTextBytes?: number;
}): string {
  const responseText =
    opts.bodyTextBytes !== undefined && opts.bodyTextBytes > 0
      ? `{"k":"${"x".repeat(opts.bodyTextBytes)}"}`
      : '{"k":"v"}';
  return JSON.stringify({
    v: 1,
    runId: "1779260470000_18866",
    seq: opts.seq,
    pid: 18866,
    tsMs: 1_779_260_473_246,
    durationMs: 100,
    method: "GET",
    url: opts.url,
    path: new URL(opts.url).pathname,
    host: new URL(opts.url).host,
    protocol: "h2",
    heartBeat: false,
    request: {
      headers:
        opts.authValue === undefined ? [] : [{ name: "Authorization", value: opts.authValue }],
      params: [],
      decoded: null,
      body: {
        contentType: null,
        charset: null,
        text: null,
        textBytes: null,
        omittedReason: "no-body",
        preview: null,
        previewBytes: null,
      },
    },
    response: {
      status: 200,
      headers: [],
      body: {
        contentType: "application/json",
        charset: "UTF-8",
        text: responseText,
        textBytes: responseText.length,
        omittedReason: null,
        preview: null,
        previewBytes: null,
      },
      app: null,
    },
    error: null,
  });
}

function makePoppoRunDir(
  opts: {
    withGarbageLine?: boolean;
    withMtimeCache?: boolean;
    /** When set, the single poppo_http record carries a response body of this size. */
    bodyTextBytes?: number;
  } = {},
): string {
  const runDir = join(workDir, RUN_ID);
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "metadata.json"), "{}");
  writeFileSync(join(runDir, "events.jsonl"), '{"type":"mark","ts":"T"}\n');
  // Logcat present so we can test the orthogonality with logs:"raw".
  writeFileSync(
    join(runDir, "logcat.jsonl"),
    `${JSON.stringify({ tsRaw: "05-20 10:00:00.000", message: "Authorization: Basic c2VjcmV0" })}\n`,
  );
  writeFileSync(join(runDir, "logcat.raw.txt"), "raw byte log line\n");

  // Evidence dir for poppo_http with one record carrying redactables + an
  // optional parse-null sentinel line that MUST NOT leak raw to the bundle.
  const evidenceDir = join(runDir, "evidence", "poppo_http");
  mkdirSync(evidenceDir, { recursive: true });
  const lines: string[] = [];
  if (opts.withGarbageLine === true) {
    lines.push("not-a-valid-json-record-half-line");
  }
  lines.push(
    poppoRecord({
      seq: 1,
      url: "https://api.example.com/users?_sign=SECRETSIGN&id=42",
      authValue: "Bearer SECRETTOKEN",
      ...(opts.bodyTextBytes !== undefined ? { bodyTextBytes: opts.bodyTextBytes } : {}),
    }),
  );
  lines.push("");
  writeFileSync(join(evidenceDir, "http_2026-05-26_0.jsonl"), lines.join("\n"));
  if (opts.withMtimeCache !== false) {
    writeFileSync(
      join(evidenceDir, ".mtime-cache.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "/sdcard/Android/data/com.baitu.poppo/files/http-logs/http_2026-05-26_0.jsonl": {
            mtimeMs: 1_716_000_000_000,
            localPath: join(evidenceDir, "http_2026-05-26_0.jsonl"),
          },
        },
      }),
    );
  }
  return runDir;
}

async function buildPoppo(opts: {
  logs: BundleLogs;
  withGarbageLine?: boolean;
  bodyTextBytes?: number;
}): Promise<{ entries: string[]; bundlePath: string }> {
  const result = await createBundle({
    runDir: makePoppoRunDir({
      ...(opts.withGarbageLine === true ? { withGarbageLine: true } : {}),
      ...(opts.bodyTextBytes !== undefined ? { bodyTextBytes: opts.bodyTextBytes } : {}),
    }),
    runId: RUN_ID,
    bundlesDir: join(workDir, "bundles"),
    logs: opts.logs,
    profile: POPPO_VONE_PROFILE,
  });
  return { entries: await bundleEntries(result.bundlePath), bundlePath: result.bundlePath };
}

function makeExtractDir(): string {
  const extractDir = join(
    workDir,
    `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(extractDir, { recursive: true });
  return extractDir;
}

describe("createBundle — v2-G Phase 5 (i) evidence redaction (Q6)", () => {
  it("redacts Authorization header + _sign query in evidence jsonl when bundled", async () => {
    const { entries, bundlePath } = await buildPoppo({ logs: "redacted" });

    // Evidence file present, mtime cache absent.
    expect(entries.some((e) => e.endsWith("evidence/poppo_http/http_2026-05-26_0.jsonl"))).toBe(
      true,
    );
    expect(entries.some((e) => e.includes(".mtime-cache.json"))).toBe(false);

    const extractDir = makeExtractDir();
    await exec("tar", ["-xzf", bundlePath, "-C", extractDir]);
    const redacted = readFileSync(
      join(extractDir, RUN_ID, "evidence", "poppo_http", "http_2026-05-26_0.jsonl"),
      "utf8",
    );
    // Sensitive substrings GONE from bundle.
    expect(redacted).not.toContain("SECRETTOKEN");
    expect(redacted).not.toContain("SECRETSIGN");
    // Header value replaced with raw placeholder.
    expect(redacted).toContain('"value":"[REDACTED]"');
    // url field carries URL-encoded placeholder.
    expect(redacted).toContain("_sign=%5BREDACTED%5D");
  });

  it('logs:"raw" + acknowledgeUnredacted does NOT disable evidence redaction', async () => {
    // We're below the tool handler here so acknowledgeUnredacted isn't even a
    // parameter; the assertion is structural: bundle.ts always redacts
    // evidence regardless of logs mode. Codex Phase 5 (i) audit required fix #1.
    const { entries, bundlePath } = await buildPoppo({ logs: "raw" });
    // Logcat raw IS shipped per logs:"raw"...
    expect(entries.some((e) => e.endsWith("logcat.jsonl"))).toBe(true);
    expect(entries.some((e) => e.endsWith("logcat.raw.txt"))).toBe(true);

    // ...but evidence is still redacted.
    const extractDir = makeExtractDir();
    await exec("tar", ["-xzf", bundlePath, "-C", extractDir]);
    const evidence = readFileSync(
      join(extractDir, RUN_ID, "evidence", "poppo_http", "http_2026-05-26_0.jsonl"),
      "utf8",
    );
    expect(evidence).not.toContain("SECRETTOKEN");
    expect(evidence).not.toContain("SECRETSIGN");
  });

  it("drops .mtime-cache.json from the archive (host-absolute path leak)", async () => {
    const { entries } = await buildPoppo({ logs: "redacted" });
    expect(entries.some((e) => e.includes(".mtime-cache.json"))).toBe(false);
  });

  it("never ships a parse-null evidence line raw — drops it consistently with source.parseLine", async () => {
    const { bundlePath } = await buildPoppo({ logs: "redacted", withGarbageLine: true });
    const extractDir = makeExtractDir();
    await exec("tar", ["-xzf", bundlePath, "-C", extractDir]);
    const evidence = readFileSync(
      join(extractDir, RUN_ID, "evidence", "poppo_http", "http_2026-05-26_0.jsonl"),
      "utf8",
    );
    expect(evidence).not.toContain("not-a-valid-json-record-half-line");
    // Exactly one valid record line (plus trailing newline).
    expect(evidence.trim().split("\n")).toHaveLength(1);
  });

  it("accepts an evidence record well above the default 64 KiB cap (v2-G acceptance regression)", async () => {
    // The default AppendStream cap is 64 KiB — appropriate for events / logcat
    // streams the server produces. Pre-fix, evidence redaction inherited this
    // cap and threw `JsonlLineTooLargeError` on Poppo i18n responses (~670 KB),
    // blocking collect_bundle entirely. We now open the redact stream with a
    // 16 MiB override; an ~800 KiB record (10x the old ceiling, comfortably
    // below the new one) must round-trip into the bundle intact.
    const { entries, bundlePath } = await buildPoppo({
      logs: "redacted",
      bodyTextBytes: 800 * 1024,
    });
    expect(entries.some((e) => e.endsWith("evidence/poppo_http/http_2026-05-26_0.jsonl"))).toBe(
      true,
    );
    const extractDir = makeExtractDir();
    await exec("tar", ["-xzf", bundlePath, "-C", extractDir]);
    const evidence = readFileSync(
      join(extractDir, RUN_ID, "evidence", "poppo_http", "http_2026-05-26_0.jsonl"),
      "utf8",
    );
    // Record landed in the bundle (>800 KiB on disk).
    expect(evidence.length).toBeGreaterThan(800 * 1024);
    // Redaction still applied across the large record.
    expect(evidence).not.toContain("SECRETTOKEN");
    expect(evidence).not.toContain("SECRETSIGN");
    expect(evidence).toContain('"value":"[REDACTED]"');
  });
});
