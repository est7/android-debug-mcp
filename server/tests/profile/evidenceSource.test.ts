import { describe, expect, it } from "vitest";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../../src/profile/types.ts";

/**
 * Phase 2 interface contract tests. No tool is registered yet (Phase 3) and
 * no concrete impl exists (Phase 4) — these tests guard the SHAPE of the
 * interface so Phase 3 wiring and Phase 4 implementers can both rely on it.
 *
 * The fake source below is the smallest impl that exercises every method;
 * it also doubles as a reference for what a real source looks like.
 */

// A narrow record type the fake source emits internally — typed at the impl
// boundary, opaque at the interface boundary (matches the Phase 4 plan).
interface FakeRecord {
  readonly source: "fake_src";
  readonly tsMs: number;
  readonly path: string;
  readonly authHeader: string;
}

interface FakeQuery {
  readonly source: "fake_src";
  readonly pathPrefix?: string;
}

/** Toy line format: `<tsMs>|<path>|<authHeader>`. */
function makeFake(opts: {
  files: readonly DeviceFileEntry[];
  onPull?: (deviceFile: DeviceFileEntry, localPath: string) => void;
}): EvidenceSource {
  return {
    id: "fake_src",
    async listDeviceFiles(_ctx: EvidenceContext) {
      return opts.files;
    },
    async pullFile(_ctx: EvidenceContext, deviceFile: DeviceFileEntry, localPath: string) {
      opts.onPull?.(deviceFile, localPath);
    },
    parseLine(line: string): ParsedRecord | null {
      const parts = line.split("|");
      if (parts.length !== 3) return null;
      const tsStr = parts[0] as string;
      const ts = Number.parseInt(tsStr, 10);
      if (!Number.isFinite(ts)) return null;
      const rec: FakeRecord = {
        source: "fake_src",
        tsMs: ts,
        path: parts[1] as string,
        authHeader: parts[2] as string,
      };
      return rec as unknown as ParsedRecord;
    },
    matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean {
      const r = record as unknown as FakeRecord;
      const q = query as unknown as FakeQuery;
      if (q.pathPrefix !== undefined && !r.path.startsWith(q.pathPrefix)) return false;
      return true;
    },
    redactForBundle(record: ParsedRecord): ParsedRecord {
      const r = record as unknown as FakeRecord;
      const redacted: FakeRecord = { ...r, authHeader: "[REDACTED]" };
      return redacted as unknown as ParsedRecord;
    },
  };
}

const ctx: EvidenceContext = {
  deviceSerial: "DEV0",
  sessionStartMs: 1_716_600_000_000,
  deviceTimezone: "Asia/Shanghai",
};

describe("EvidenceSource interface contract", () => {
  it("listDeviceFiles returns DeviceFileEntry[] with the documented fields", async () => {
    const files: DeviceFileEntry[] = [
      { path: "/d/http_2026-05-26_0.jsonl", name: "http_2026-05-26_0.jsonl", mtimeMs: 100 },
    ];
    const src = makeFake({ files });
    const got = await src.listDeviceFiles(ctx);
    expect(got).toEqual(files);
    expect(got[0]).toMatchObject({
      path: expect.any(String),
      name: expect.any(String),
      mtimeMs: 100,
    });
  });

  it("pullFile is invoked with ctx + DeviceFileEntry + localPath", async () => {
    const calls: Array<{ devicePath: string; localPath: string }> = [];
    const src = makeFake({
      files: [],
      onPull: (df, lp) => calls.push({ devicePath: df.path, localPath: lp }),
    });
    await src.pullFile(
      ctx,
      { path: "/d/x.jsonl", name: "x.jsonl", mtimeMs: 1 },
      "/tmp/local/x.jsonl",
    );
    expect(calls).toEqual([{ devicePath: "/d/x.jsonl", localPath: "/tmp/local/x.jsonl" }]);
  });

  it("parseLine returns a ParsedRecord with the source discriminator set", () => {
    const src = makeFake({ files: [] });
    const r = src.parseLine("1716678000000|/api/v1/users|Bearer abc");
    expect(r).not.toBeNull();
    expect(r?.source).toBe("fake_src");
  });

  it("parseLine returns null on malformed input (no throw)", () => {
    const src = makeFake({ files: [] });
    expect(src.parseLine("garbage")).toBeNull();
    expect(src.parseLine("not|enough")).toBeNull();
    expect(src.parseLine("not-a-number|/p|h")).toBeNull();
  });

  it("matchQuery applies the per-source filter shape", () => {
    const src = makeFake({ files: [] });
    const rec = src.parseLine("1|/api/v1/users|h") as ParsedRecord;
    const matchYes: EvidenceQuery = { source: "fake_src", pathPrefix: "/api/v1" };
    const matchNo: EvidenceQuery = { source: "fake_src", pathPrefix: "/different" };
    expect(src.matchQuery(rec, matchYes)).toBe(true);
    expect(src.matchQuery(rec, matchNo)).toBe(false);
  });

  it("redactForBundle returns a record with the same shape (source preserved)", () => {
    const src = makeFake({ files: [] });
    const rec = src.parseLine("1|/api/v1/users|Bearer abc") as ParsedRecord;
    const out = src.redactForBundle(rec);
    expect(out.source).toBe("fake_src");
    // Concrete redaction policy is source-internal — verify only the contract:
    // the output is a record with the right discriminator.
    expect(typeof out.source).toBe("string");
  });

  it("source.id is the same string used as the discriminator on emitted records", () => {
    const src = makeFake({ files: [] });
    const rec = src.parseLine("1|/p|h") as ParsedRecord;
    expect(rec.source).toBe(src.id);
  });
});
