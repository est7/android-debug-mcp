import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVIDENCE_SUBDIR,
  MTIME_CACHE_FILENAME,
  mtimeCachePath,
  readMtimeCache,
  sourceEvidenceDir,
  writeMtimeCache,
} from "../../src/evidence/mtimeCache.ts";

let runDir = "";

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "adm-mtime-cache-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("nests under <runDir>/evidence/<sourceId>/", () => {
    expect(sourceEvidenceDir("/r", "poppo_http")).toBe(`/r/${EVIDENCE_SUBDIR}/poppo_http`);
  });
  it("places the cache file inside the source dir", () => {
    expect(mtimeCachePath("/r", "poppo_http")).toBe(
      `/r/${EVIDENCE_SUBDIR}/poppo_http/${MTIME_CACHE_FILENAME}`,
    );
  });
});

describe("readMtimeCache", () => {
  it("returns an empty map when the cache file does not exist", async () => {
    const cache = await readMtimeCache(runDir, "poppo_http");
    expect(cache).toEqual({});
  });

  it("returns an empty map when the source dir does not exist either", async () => {
    // No mkdir at all — runDir is empty
    const cache = await readMtimeCache(runDir, "fresh_source");
    expect(cache).toEqual({});
  });

  it("round-trips a cache written by writeMtimeCache", async () => {
    await writeMtimeCache(runDir, "poppo_http", {
      "/sdcard/Android/data/com.x/files/http-logs/http_2026-05-26_0.jsonl": {
        mtimeMs: 1716678000_000,
        localPath: `${runDir}/evidence/poppo_http/http_2026-05-26_0.jsonl`,
      },
      "/sdcard/Android/data/com.x/files/http-logs/http_2026-05-25_0.jsonl": {
        mtimeMs: 1716591600_000,
        localPath: `${runDir}/evidence/poppo_http/http_2026-05-25_0.jsonl`,
      },
    });
    const cache = await readMtimeCache(runDir, "poppo_http");
    expect(Object.keys(cache)).toHaveLength(2);
    expect(cache["/sdcard/Android/data/com.x/files/http-logs/http_2026-05-26_0.jsonl"]).toEqual({
      mtimeMs: 1716678000_000,
      localPath: `${runDir}/evidence/poppo_http/http_2026-05-26_0.jsonl`,
    });
  });

  it("throws on invalid JSON", async () => {
    const sourceDir = join(runDir, EVIDENCE_SUBDIR, "poppo_http");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, MTIME_CACHE_FILENAME), "{ not valid");
    await expect(readMtimeCache(runDir, "poppo_http")).rejects.toThrow(/not valid JSON/);
  });

  it("throws on schema mismatch (.strict() rejects unknown keys)", async () => {
    const sourceDir = join(runDir, EVIDENCE_SUBDIR, "poppo_http");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, MTIME_CACHE_FILENAME),
      JSON.stringify({ version: 1, entries: {}, extra: "no" }),
    );
    await expect(readMtimeCache(runDir, "poppo_http")).rejects.toThrow(/failed validation/);
  });

  it("throws when the version literal is wrong (forward-compat anchor)", async () => {
    const sourceDir = join(runDir, EVIDENCE_SUBDIR, "poppo_http");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, MTIME_CACHE_FILENAME),
      JSON.stringify({ version: 2, entries: {} }),
    );
    await expect(readMtimeCache(runDir, "poppo_http")).rejects.toThrow(/failed validation/);
  });

  it("rejects an entry whose mtimeMs is negative", async () => {
    const sourceDir = join(runDir, EVIDENCE_SUBDIR, "poppo_http");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, MTIME_CACHE_FILENAME),
      JSON.stringify({
        version: 1,
        entries: { "/d/x": { mtimeMs: -1, localPath: "/l/x" } },
      }),
    );
    await expect(readMtimeCache(runDir, "poppo_http")).rejects.toThrow(/failed validation/);
  });
});

describe("writeMtimeCache", () => {
  it("creates the per-source dir before writing", async () => {
    // Nothing under runDir/evidence yet.
    await writeMtimeCache(runDir, "poppo_http", {
      "/d/x": { mtimeMs: 1, localPath: "/l/x" },
    });
    const text = readFileSync(mtimeCachePath(runDir, "poppo_http"), "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      entries: { "/d/x": { mtimeMs: 1, localPath: "/l/x" } },
    });
  });

  it("overwrites an existing cache file (last write wins)", async () => {
    await writeMtimeCache(runDir, "poppo_http", {
      "/d/x": { mtimeMs: 1, localPath: "/l/x" },
    });
    await writeMtimeCache(runDir, "poppo_http", {
      "/d/x": { mtimeMs: 2, localPath: "/l/x" },
      "/d/y": { mtimeMs: 3, localPath: "/l/y" },
    });
    const cache = await readMtimeCache(runDir, "poppo_http");
    expect(cache).toEqual({
      "/d/x": { mtimeMs: 2, localPath: "/l/x" },
      "/d/y": { mtimeMs: 3, localPath: "/l/y" },
    });
  });

  it("writes formatted JSON with a trailing newline", async () => {
    await writeMtimeCache(runDir, "poppo_http", {
      "/d/x": { mtimeMs: 1, localPath: "/l/x" },
    });
    const text = readFileSync(mtimeCachePath(runDir, "poppo_http"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"version": 1');
  });

  it("rejects in-memory garbage at the write boundary (defense vs caller mutation)", async () => {
    // Cast bypasses the type — simulates a buggy caller writing wrong shapes.
    const bad = { "/d/x": { mtimeMs: "not-a-number", localPath: "/l/x" } } as unknown as Record<
      string,
      { mtimeMs: number; localPath: string }
    >;
    await expect(writeMtimeCache(runDir, "poppo_http", bad)).rejects.toThrow();
  });

  it("keeps independent source caches isolated", async () => {
    await writeMtimeCache(runDir, "source_a", {
      "/d/a": { mtimeMs: 100, localPath: "/l/a" },
    });
    await writeMtimeCache(runDir, "source_b", {
      "/d/b": { mtimeMs: 200, localPath: "/l/b" },
    });
    expect(await readMtimeCache(runDir, "source_a")).toEqual({
      "/d/a": { mtimeMs: 100, localPath: "/l/a" },
    });
    expect(await readMtimeCache(runDir, "source_b")).toEqual({
      "/d/b": { mtimeMs: 200, localPath: "/l/b" },
    });
  });
});
