import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { searchEvidence } from "../../src/evidence/runtime.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
  PreviewResult,
} from "../../src/profile/types.ts";

/**
 * v2-G.1 Phase 1 — runtime preview plumbing.
 *
 * Two-axis coverage:
 *
 *   - `_meta` reservation invariant (Q5b invariant #6) — must fire across
 *     all three call shapes regardless of whether the source declares
 *     `previewForAgent?` or whether the caller opts into `fullRecords:true`.
 *   - Preview projection — when the source declares `previewForAgent?` AND
 *     the caller did NOT opt out via `fullRecords:true`, the runtime injects
 *     `_meta.preview` on every page record. Otherwise raw passthrough (no
 *     `_meta`).
 *
 * Each scenario uses a fake source with controllable `parseLine` output —
 * one variant emits records carrying `_meta` (contract bug shape) so the
 * pre-projection invariant has something to reject.
 */

interface FakeRecord {
  readonly source: "fake_src";
  readonly tsMs: number;
  readonly body: string;
}

function makeFakeSource(opts: {
  files: readonly DeviceFileEntry[];
  bytes: Readonly<Record<string, string>>;
  /** When true, parseLine stamps a forbidden `_meta` key on its output. */
  emitMeta?: boolean;
  /** When set, source declares `previewForAgent?` with this implementation. */
  previewForAgent?: (record: ParsedRecord) => PreviewResult;
  /** When true, source declares `sortKey?` so runtime takes the sort path. */
  sortable?: boolean;
}): EvidenceSource {
  const source: EvidenceSource = {
    id: "fake_src",
    querySchema: z
      .object({
        source: z.literal("fake_src"),
      })
      .strict(),
    async listDeviceFiles() {
      return opts.files;
    },
    async pullFile(_ctx, deviceFile, localPath) {
      const data = opts.bytes[deviceFile.path];
      if (data === undefined) throw new Error(`test fake: no bytes for ${deviceFile.path}`);
      await mkdir(join(localPath, ".."), { recursive: true });
      await writeFile(localPath, data, "utf8");
    },
    parseLine(line: string): ParsedRecord | null {
      const parts = line.split("|");
      if (parts.length !== 2) return null;
      const ts = Number.parseInt(parts[0] as string, 10);
      if (!Number.isFinite(ts)) return null;
      const base: FakeRecord = { source: "fake_src", tsMs: ts, body: parts[1] as string };
      if (opts.emitMeta === true) {
        return { ...base, _meta: { producerInjected: true } } as unknown as ParsedRecord;
      }
      return base as unknown as ParsedRecord;
    },
    matchQuery() {
      return true;
    },
    redactForBundle(r) {
      return r;
    },
  };
  if (opts.previewForAgent !== undefined) {
    source.previewForAgent = opts.previewForAgent;
  }
  if (opts.sortable === true) {
    source.sortKey = (record) => {
      const r = record as unknown as FakeRecord;
      return [r.tsMs];
    };
  }
  return source;
}

const ctx: EvidenceContext = {
  deviceSerial: "DEV0",
  packageName: "com.example.fake",
  sessionStartMs: 1_716_600_000_000,
  deviceTimezone: "Asia/Shanghai",
};

const FILE: DeviceFileEntry = {
  path: "/d/http_2026-05-26_0.jsonl",
  name: "http_2026-05-26_0.jsonl",
  mtimeMs: 100,
};
const BYTES = ["1716600000000|hello", "1716600001000|world", ""].join("\n");

const _META_ERROR =
  /source 'fake_src' produced record with reserved key _meta;.*server-owned metadata namespace/;

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "v2g1-preview-"));
});
afterEach(() => {
  runDir = "";
});

describe("v2-G.1 Phase 1 — runtime _meta reservation invariant", () => {
  it("preview path: throws when parseLine emits _meta and source declares previewForAgent", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      emitMeta: true,
      previewForAgent: (record) => ({
        record,
        truncated: false,
        fullSizeBytes: 100,
        truncatedFields: [],
      }),
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: null,
      }),
    ).rejects.toThrow(_META_ERROR);
  });

  it("fullRecords:true bypass: throws when parseLine emits _meta even though preview is skipped", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      emitMeta: true,
      previewForAgent: (record) => ({
        record,
        truncated: false,
        fullSizeBytes: 100,
        truncatedFields: [],
      }),
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: null,
        fullRecords: true,
      }),
    ).rejects.toThrow(_META_ERROR);
  });

  it("no-hook bypass: throws when parseLine emits _meta even though source has no previewForAgent", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      emitMeta: true,
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: null,
      }),
    ).rejects.toThrow(_META_ERROR);
  });

  it("hook output: throws when previewForAgent returns a record carrying _meta (codex Phase 1 audit fix)", async () => {
    // parseLine emits a CLEAN record (passes the raw-record guard), but
    // previewForAgent returns one carrying _meta. The runtime must throw
    // before wrapping — silently overwriting the source-owned key would
    // reintroduce the namespace collision Q3 / Q5b invariant #6 forbid.
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      previewForAgent: (record) => ({
        record: { ...record, _meta: { hookInjected: true } } as unknown as ParsedRecord,
        truncated: true,
        fullSizeBytes: 100,
        truncatedFields: [],
      }),
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: null,
      }),
    ).rejects.toThrow(_META_ERROR);
  });
});

describe("v2-G.1 Phase 1 — runtime previewForAgent projection", () => {
  it("source with previewForAgent: injects _meta.preview on every page record", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      previewForAgent: (record) => ({
        record: { ...record, body: "[truncated]" },
        truncated: true,
        fullSizeBytes: 999,
        truncatedFields: ["body"],
      }),
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

    expect(out.records).toHaveLength(2);
    for (const rec of out.records) {
      const r = rec as unknown as { body: string; _meta: { preview: PreviewResult } };
      expect(r.body).toBe("[truncated]");
      expect(r._meta.preview.truncated).toBe(true);
      expect(r._meta.preview.fullSizeBytes).toBe(999);
      expect(r._meta.preview.truncatedFields).toEqual(["body"]);
    }
  });

  it("source without previewForAgent: raw passthrough, no _meta injection", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
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

    expect(out.records).toHaveLength(2);
    for (const rec of out.records) {
      expect((rec as { _meta?: unknown })._meta).toBeUndefined();
    }
  });

  it("fullRecords:true: skips previewForAgent, raw passthrough, no _meta injection", async () => {
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      previewForAgent: (record) => ({
        record: { ...record, body: "[truncated]" },
        truncated: true,
        fullSizeBytes: 999,
        truncatedFields: ["body"],
      }),
    });

    const out = await searchEvidence({
      source,
      parsedQuery: { source: "fake_src" } as EvidenceQuery,
      ctx,
      runId: "run-1",
      runDir,
      limit: 100,
      cursor: null,
      fullRecords: true,
    });

    expect(out.records).toHaveLength(2);
    for (const rec of out.records) {
      const r = rec as unknown as { body: string; _meta?: unknown };
      expect(r.body).not.toBe("[truncated]"); // hook NOT called
      expect(r._meta).toBeUndefined();
    }
  });

  it("sort path symmetry: previewForAgent fires after sort+keyset slice, _meta.preview injected", async () => {
    // Sortable source → runtime takes runSortPath (collect → sort → slice).
    // Verifies stream/sort symmetry contract: helper runs identically on
    // both code paths' page records.
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      sortable: true,
      previewForAgent: (record) => ({
        record: { ...record, body: "[sort-truncated]" },
        truncated: true,
        fullSizeBytes: 777,
        truncatedFields: ["body"],
      }),
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

    expect(out.records).toHaveLength(2);
    // Sort order on [tsMs]: 1716600000000 (hello) before 1716600001000 (world).
    const first = out.records[0] as unknown as {
      tsMs: number;
      body: string;
      _meta: { preview: PreviewResult };
    };
    expect(first.tsMs).toBe(1_716_600_000_000);
    expect(first.body).toBe("[sort-truncated]");
    expect(first._meta.preview.truncated).toBe(true);
    expect(first._meta.preview.fullSizeBytes).toBe(777);
    expect(first._meta.preview.truncatedFields).toEqual(["body"]);
  });

  it("sort path: hook output _meta collision still throws", async () => {
    // Same hook-output collision check, exercised through runSortPath.
    const source = makeFakeSource({
      files: [FILE],
      bytes: { [FILE.path]: BYTES },
      sortable: true,
      previewForAgent: (record) => ({
        record: { ...record, _meta: { sortHookInjected: true } } as unknown as ParsedRecord,
        truncated: true,
        fullSizeBytes: 100,
        truncatedFields: [],
      }),
    });

    await expect(
      searchEvidence({
        source,
        parsedQuery: { source: "fake_src" } as EvidenceQuery,
        ctx,
        runId: "run-1",
        runDir,
        limit: 100,
        cursor: null,
      }),
    ).rejects.toThrow(_META_ERROR);
  });
});
