import { describe, expect, it } from "vitest";
import { type DecodedCursor, decodeCursor, encodeCursor } from "../../src/evidence/cursor.ts";
import type { MtimeCache } from "../../src/evidence/mtimeCache.ts";
import { sourceEvidenceDir } from "../../src/evidence/paths.ts";
import { ToolDomainError } from "../../src/mcp/toolError.ts";

/**
 * Cursor threat-model coverage (codex amendment #2).
 *
 * Every defense documented in `cursor.ts` must have at least one assertion
 * here. New cursor fields must add a `decode` test that exercises a
 * deliberate violation of that field, otherwise the regression surface
 * shrinks silently.
 */

const RUN_DIR = "/tmp/test-run";
const SOURCE_ID = "fake_src";
const FILE_KEY = "data_2026-05-26.jsonl";

function withCache(localPath: string): MtimeCache {
  return {
    "/device/path/x": { mtimeMs: 1000, localPath },
  };
}

const goodLocal = `${sourceEvidenceDir(RUN_DIR, SOURCE_ID)}/${FILE_KEY}`;
const cache = withCache(goodLocal);

const ctx = { runId: "run-1", sourceId: SOURCE_ID, runDir: RUN_DIR, cache };

describe("encodeCursor", () => {
  it("round-trips a well-formed cursor", () => {
    const c = { runId: "run-1", source: SOURCE_ID, fileKey: FILE_KEY, lineOffset: 12 };
    const out = decodeCursor(encodeCursor(c), ctx);
    expect(out.cursor).toEqual(c);
    expect(out.localPath).toBe(goodLocal);
  });

  it("refuses to emit a cursor with a path-separator in fileKey", () => {
    expect(() =>
      encodeCursor({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: "a/b",
        lineOffset: 0,
      }),
    ).toThrow();
  });

  it("refuses to emit a cursor with negative lineOffset", () => {
    expect(() =>
      encodeCursor({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: FILE_KEY,
        lineOffset: -1,
      }),
    ).toThrow();
  });
});

describe("decodeCursor — defenses", () => {
  function expectInvalidCursor(fn: () => DecodedCursor, fragment?: string): ToolDomainError {
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolDomainError);
    const err = caught as ToolDomainError;
    expect(err.code).toBe("invalid_cursor");
    if (fragment !== undefined) expect(err.message).toContain(fragment);
    return err;
  }

  it("rejects non-base64 bytes", () => {
    expectInvalidCursor(() => decodeCursor("!!!not base64!!!", ctx), "decodable");
  });

  it("rejects base64 of non-JSON", () => {
    const garbage = Buffer.from("this is not json", "utf8").toString("base64");
    expectInvalidCursor(() => decodeCursor(garbage, ctx), "decodable");
  });

  it("rejects a cursor missing required fields", () => {
    const bad = Buffer.from(JSON.stringify({ runId: "run-1" }), "utf8").toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "shape invalid");
  });

  it("rejects a cursor with an extra key (.strict())", () => {
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: FILE_KEY,
        lineOffset: 0,
        evil: "yes",
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "shape invalid");
  });

  it("rejects cross-run misuse (runId mismatch)", () => {
    const bad = Buffer.from(
      JSON.stringify({ runId: "OTHER-RUN", source: SOURCE_ID, fileKey: FILE_KEY, lineOffset: 0 }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "runId mismatch");
  });

  it("rejects cross-source misuse (source mismatch)", () => {
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: "other_src",
        fileKey: FILE_KEY,
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "source mismatch");
  });

  it("rejects fileKey containing a path separator (regex)", () => {
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: "../escape.jsonl",
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "shape invalid");
  });

  it("rejects fileKey containing a backslash (regex)", () => {
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: "..\\escape.jsonl",
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "shape invalid");
  });

  it("rejects fileKey that is not in the mtime cache (post-resolve)", () => {
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: "never-pulled.jsonl",
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "no entry in the mtime cache");
  });

  it("rejects fileKey ` .. ` via the path-escape resolve check", () => {
    // Bare `..` is a legal basename to the regex (no separator), but
    // resolving `<sourceEvidenceDir>/..` lands at the parent. The
    // resolve-prefix check is the layer that catches this — independent
    // of the mtime-cache membership check below — so a future regex
    // loosening cannot open this hole.
    const bad = Buffer.from(
      JSON.stringify({
        runId: "run-1",
        source: SOURCE_ID,
        fileKey: "..",
        lineOffset: 0,
      }),
      "utf8",
    ).toString("base64");
    expectInvalidCursor(() => decodeCursor(bad, ctx), "resolves outside");
  });
});
