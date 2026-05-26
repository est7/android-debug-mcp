import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { encodeCursor } from "../../src/evidence/cursor.ts";
import {
  type MtimeCache,
  readMtimeCache,
  sourceEvidenceDir,
} from "../../src/evidence/mtimeCache.ts";
import { searchEvidence } from "../../src/evidence/runtime.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../../src/profile/types.ts";

/**
 * Phase 3 runtime e2e tests on a temp run-folder.
 *
 * The fake source's `pullFile` writes a caller-supplied byte string to
 * `localPath` so we exercise the real `node:fs/promises` read path used by
 * `iterateLocal`. mtime cache I/O hits real disk; the search loop hits real
 * disk. The only thing not real is `adb` itself.
 */

interface FakeRecord {
  readonly source: "fake_src";
  readonly tsMs: number;
  readonly path: string;
}
interface FakeQuery {
  readonly source: "fake_src";
  readonly pathPrefix?: string;
  readonly tsMsRange?: { from?: number; to?: number };
}

function makeFakeSource(opts: {
  files: readonly DeviceFileEntry[];
  /** Map from device path → newline-joined record lines that pullFile writes locally. */
  bytes: Readonly<Record<string, string>>;
  pulls?: Array<{ devicePath: string; localPath: string }>;
}): EvidenceSource {
  return {
    id: "fake_src",
    querySchema: z
      .object({
        source: z.literal("fake_src"),
        pathPrefix: z.string().optional(),
        tsMsRange: z
          .object({
            from: z.number().int().optional(),
            to: z.number().int().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    async listDeviceFiles(_ctx) {
      return opts.files;
    },
    async pullFile(_ctx, deviceFile, localPath) {
      const data = opts.bytes[deviceFile.path];
      if (data === undefined) {
        throw new Error(`test fake: no bytes for ${deviceFile.path}`);
      }
      await mkdir(join(localPath, ".."), { recursive: true });
      await writeFile(localPath, data, "utf8");
      opts.pulls?.push({ devicePath: deviceFile.path, localPath });
    },
    parseLine(line: string): ParsedRecord | null {
      const parts = line.split("|");
      if (parts.length !== 2) return null;
      const ts = Number.parseInt(parts[0] as string, 10);
      if (!Number.isFinite(ts)) return null;
      const r: FakeRecord = { source: "fake_src", tsMs: ts, path: parts[1] as string };
      return r as unknown as ParsedRecord;
    },
    matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean {
      const r = record as unknown as FakeRecord;
      const q = query as unknown as FakeQuery;
      if (q.pathPrefix !== undefined && !r.path.startsWith(q.pathPrefix)) return false;
      if (q.tsMsRange?.from !== undefined && r.tsMs < q.tsMsRange.from) return false;
      if (q.tsMsRange?.to !== undefined && r.tsMs > q.tsMsRange.to) return false;
      return true;
    },
    redactForBundle(r) {
      return r;
    },
  };
}

const ctx: EvidenceContext = {
  deviceSerial: "DEV0",
  packageName: "com.example.fake",
  sessionStartMs: 1_716_600_000_000,
  deviceTimezone: "Asia/Shanghai",
};

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "v2g-runtime-"));
});
afterEach(async () => {
  // mkdtemp is leak-tolerant for tests; OS cleans /tmp on reboot. Skip rm to
  // keep test parallelism safe (no cross-process rm races).
  runDir = "";
});

describe("searchEvidence — lazy pull diff", () => {
  it("first call: cache miss → pulls every listed file; writes cache", async () => {
    const pulls: Array<{ devicePath: string; localPath: string }> = [];
    const source = makeFakeSource({
      files: [
        { path: "/d/http_2026-05-26_0.jsonl", name: "http_2026-05-26_0.jsonl", mtimeMs: 100 },
      ],
      bytes: {
        "/d/http_2026-05-26_0.jsonl": [
          "1716600000000|/api/v1/users",
          "1716600001000|/api/v1/orders",
          "",
        ].join("\n"),
      },
      pulls,
    });

    const out = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });

    expect(pulls.length).toBe(1);
    expect(out.pulls.length).toBe(1);
    expect(out.pulls[0]?.trigger).toBe("lazy");
    expect(out.records.length).toBe(2);
    expect(out.statsRun.filesScanned).toBe(1);
    expect(out.statsRun.recordsScanned).toBe(2);
    expect(out.statsRun.pullsTriggered).toBe(1);
    expect(out.nextCursor).toBeNull();

    const cache = await readMtimeCache(runDir, "fake_src");
    expect(cache["/d/http_2026-05-26_0.jsonl"]).toMatchObject({ mtimeMs: 100 });
  });

  it("second call with same device mtime: cache hit → no pull, still reads local", async () => {
    const pulls: Array<{ devicePath: string; localPath: string }> = [];
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "1|/x\n2|/y\n" },
      pulls,
    });

    const input = {
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    };

    const first = await searchEvidence(input);
    expect(first.pulls.length).toBe(1);
    expect(pulls.length).toBe(1);

    const second = await searchEvidence(input);
    expect(second.pulls.length).toBe(0);
    expect(pulls.length).toBe(1); // unchanged
    expect(second.records.length).toBe(2); // local read still happens
    expect(second.statsRun.pullsTriggered).toBe(0);
  });

  it("active file (mtime grew): re-pulls and updates cache", async () => {
    const pulls: Array<{ devicePath: string; localPath: string }> = [];
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "1|/x\n" },
      pulls,
    });

    await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(pulls.length).toBe(1);

    const source2 = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 200 }], // grew
      bytes: { "/d/a.jsonl": "1|/x\n2|/y\n" },
      pulls,
    });
    const out = await searchEvidence({
      source: source2,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(pulls.length).toBe(2);
    expect(out.pulls[0]?.mtimeMs).toBe(200);
    expect(out.records.length).toBe(2);

    const cache = await readMtimeCache(runDir, "fake_src");
    expect(cache["/d/a.jsonl"]?.mtimeMs).toBe(200);
  });
});

describe("searchEvidence — seal mode (codex amendment #1)", () => {
  it("seal: pulls every listed file regardless of cache match", async () => {
    const pulls: Array<{ devicePath: string; localPath: string }> = [];
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "1|/x\n" },
      pulls,
    });
    await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(pulls.length).toBe(1);

    const out = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
      mode: "seal",
    });
    expect(pulls.length).toBe(2); // pulled again despite mtime equality
    expect(out.pulls[0]?.trigger).toBe("seal");
  });
});

describe("searchEvidence — iteration / matching", () => {
  it("multiple files iterate in basename order", async () => {
    const source = makeFakeSource({
      files: [
        { path: "/d/b.jsonl", name: "b.jsonl", mtimeMs: 100 },
        { path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 },
      ],
      bytes: {
        "/d/a.jsonl": "10|/a\n",
        "/d/b.jsonl": "20|/b\n",
      },
    });
    const out = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(out.records.length).toBe(2);
    const first = out.records[0] as unknown as FakeRecord;
    const second = out.records[1] as unknown as FakeRecord;
    expect(first.path).toBe("/a");
    expect(second.path).toBe("/b");
  });

  it("matchQuery filters; parseLine null skips line (no throw on garbage)", async () => {
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: {
        "/d/a.jsonl": ["1|/api/v1/x", "garbage_line_no_pipe", "2|/other/y", "3|/api/v2/z", ""].join(
          "\n",
        ),
      },
    });
    const out = await searchEvidence({
      source,
      parsedQuery: {
        source: "fake_src",
        pathPrefix: "/api/v1",
      } as unknown as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(out.records.length).toBe(1);
    const r = out.records[0] as unknown as FakeRecord;
    expect(r.path).toBe("/api/v1/x");
    // recordsScanned counts parseable lines (3); garbage_line counted in
    // recordsScanned because it's still attempted, then parseLine returns null
    // and the line is skipped.
    expect(out.statsRun.recordsScanned).toBe(4);
  });
});

describe("searchEvidence — pagination", () => {
  it("limit reached → returns nextCursor; resume yields the rest", async () => {
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "1|/x\n2|/y\n3|/z\n4|/w\n" },
    });
    const first = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 2,
      cursor: null,
    });
    expect(first.records.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: first.nextCursor,
    });
    expect(second.records.length).toBe(2);
    expect(second.nextCursor).toBeNull();
    const r0 = second.records[0] as unknown as FakeRecord;
    expect(r0.tsMs).toBe(3);
  });

  it("a tampered cursor (foreign runId) throws invalid_cursor", async () => {
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "1|/x\n" },
    });
    await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });

    // Encode a cursor with a foreign runId; we only need a cache that lists
    // the file to hit the runId check.
    const cache: MtimeCache = {
      "/d/a.jsonl": {
        mtimeMs: 100,
        localPath: join(sourceEvidenceDir(runDir, "fake_src"), "a.jsonl"),
      },
    };
    void cache;
    const tampered = encodeCursor({
      kind: "stream",
      runId: "OTHER",
      source: "fake_src",
      fileKey: "a.jsonl",
      lineOffset: 0,
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: tampered,
      }),
    ).rejects.toMatchObject({ name: "ToolDomainError", code: "invalid_cursor" });
  });
});

describe("searchEvidence — empty paths", () => {
  it("source returns empty deviceFiles → no pulls, no records, no cache write", async () => {
    const source = makeFakeSource({ files: [], bytes: {} });
    const out = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(out.pulls.length).toBe(0);
    expect(out.records.length).toBe(0);
    expect(out.statsRun.filesScanned).toBe(0);

    // Cache file should not have been written; readMtimeCache returns {}
    const cache = await readMtimeCache(runDir, "fake_src");
    expect(cache).toEqual({});
  });
});

describe("searchEvidence — tsMsRange via parsedQuery (extract_evidence_context simulation)", () => {
  it("source.matchQuery honours tsMsRange when the handler injects it", async () => {
    const source = makeFakeSource({
      files: [{ path: "/d/a.jsonl", name: "a.jsonl", mtimeMs: 100 }],
      bytes: { "/d/a.jsonl": "100|/a\n200|/b\n300|/c\n" },
    });
    const out = await searchEvidence({
      source,
      parsedQuery: {
        source: "fake_src",
        tsMsRange: { from: 150, to: 250 },
      } as unknown as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    expect(out.records.length).toBe(1);
    const r = out.records[0] as unknown as FakeRecord;
    expect(r.tsMs).toBe(200);
  });
});

describe("searchEvidence — bytes really land in the per-source dir", () => {
  it("local file lives under runDir/evidence/<sourceId>/<name>", async () => {
    const source = makeFakeSource({
      files: [{ path: "/d/x.jsonl", name: "x.jsonl", mtimeMs: 1 }],
      bytes: { "/d/x.jsonl": "1|/p\n" },
    });
    await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
    });
    const expected = join(sourceEvidenceDir(runDir, "fake_src"), "x.jsonl");
    const got = await readFile(expected, "utf8");
    expect(got).toContain("1|/p");
  });
});
