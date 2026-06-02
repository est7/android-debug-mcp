import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdb } from "../../../../src/adb/adb.ts";
import { statDeviceFile } from "../../../../src/adb/evidence.ts";
import {
  matchPoppoNavRecord,
  poppoNavSource,
  shouldKeepNavByFilenameDate,
} from "../../../../src/profile/poppo-vone/poppo_nav/source.ts";
import type {
  EvidenceContext,
  EvidenceQuery,
  ParsedRecord,
} from "../../../../src/profile/types.ts";

vi.mock("../../../../src/adb/adb.ts", () => ({
  runAdb: vi.fn(),
}));

vi.mock("../../../../src/adb/evidence.ts", () => ({
  statDeviceFile: vi.fn(),
  pullFile: vi.fn(),
}));

const CTX: EvidenceContext = {
  deviceSerial: "FAKEDEV0",
  packageName: "com.baitu.poppo",
  sessionStartMs: new Date("2026-05-26T05:30:00Z").getTime(),
  deviceTimezone: "Asia/Shanghai",
};

const BASE_RECORD: ParsedRecord = {
  source: "poppo_nav",
  tsMs: 1_779_000_000_000,
  type: "open",
  name: "Home/Profile",
  host: "MainActivity",
};

function bindSession(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery {
  const fn = poppoNavSource.bindSession;
  if (fn === undefined) throw new Error("poppoNavSource.bindSession must be defined");
  return fn(query, ctx);
}

describe("poppo_nav source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has source id and a strict query schema", () => {
    expect(poppoNavSource.id).toBe("poppo_nav");
    expect(poppoNavSource.querySchema.parse({ source: "poppo_nav" })).toEqual({
      source: "poppo_nav",
    });
    expect(() => poppoNavSource.querySchema.parse({ source: "poppo_http" })).toThrow();
    expect(() => poppoNavSource.querySchema.parse({ source: "poppo_nav", junk: 1 })).toThrow();
  });

  it("accepts the H2 query fields", () => {
    expect(
      poppoNavSource.querySchema.parse({
        source: "poppo_nav",
        tsMsRange: { from: 10, to: 20 },
        typeIn: ["open", "tap"],
        nameContains: "profile",
      }),
    ).toEqual({
      source: "poppo_nav",
      tsMsRange: { from: 10, to: 20 },
      typeIn: ["open", "tap"],
      nameContains: "profile",
    });
  });

  it("matches by tsMsRange, typeIn, and case-insensitive nameContains", () => {
    expect(
      matchPoppoNavRecord(BASE_RECORD, {
        source: "poppo_nav",
        tsMsRange: { from: 1_779_000_000_000, to: 1_779_000_000_000 },
        typeIn: ["open"],
        nameContains: "profile",
      }),
    ).toBe(true);
    expect(
      matchPoppoNavRecord(BASE_RECORD, {
        source: "poppo_nav",
        tsMsRange: { from: 1_779_000_000_001, to: 1_779_000_000_010 },
      }),
    ).toBe(false);
    expect(matchPoppoNavRecord(BASE_RECORD, { source: "poppo_nav", typeIn: ["close"] })).toBe(
      false,
    );
    expect(
      matchPoppoNavRecord(BASE_RECORD, { source: "poppo_nav", nameContains: "settings" }),
    ).toBe(false);
  });

  it("bindSession only clamps tsMsRange.from when the query already has tsMsRange", () => {
    expect(bindSession({ source: "poppo_nav", nameContains: "home" }, CTX)).toEqual({
      source: "poppo_nav",
      nameContains: "home",
    });

    const bound = bindSession(
      {
        source: "poppo_nav",
        tsMsRange: { from: CTX.sessionStartMs - 1_000, to: CTX.sessionStartMs + 1_000 },
      },
      CTX,
    );
    expect(bound).toEqual({
      source: "poppo_nav",
      tsMsRange: { from: CTX.sessionStartMs, to: CTX.sessionStartMs + 1_000 },
    });
  });

  it("declares no narrowing validator and no sort key", () => {
    expect(poppoNavSource.validateNarrowingFilter).toBeUndefined();
    expect(poppoNavSource.sortKey).toBeUndefined();
  });

  it("redactForBundle is identity", () => {
    expect(poppoNavSource.redactForBundle(BASE_RECORD)).toBe(BASE_RECORD);
  });

  it("previewForAgent returns the whole record with no sections or truncation", () => {
    const preview = poppoNavSource.previewForAgent?.(BASE_RECORD, {
      fields: ["ignored"],
      fullRecords: true,
    });
    expect(preview).toEqual({
      record: BASE_RECORD,
      truncated: false,
      fullSizeBytes: Buffer.byteLength(JSON.stringify(BASE_RECORD), "utf8"),
      truncatedFields: [],
      available: [],
      sizes: {},
    });
  });

  it("filters nav_*.jsonl filenames by local date and rejects other prefixes", () => {
    expect(
      shouldKeepNavByFilenameDate("nav_2026-05-26_0.jsonl", CTX.sessionStartMs, "Asia/Shanghai"),
    ).toBe(true);
    expect(
      shouldKeepNavByFilenameDate("nav_2026-05-24_0.jsonl", CTX.sessionStartMs, "Asia/Shanghai"),
    ).toBe(false);
    expect(
      shouldKeepNavByFilenameDate("http_2026-05-26_0.jsonl", CTX.sessionStartMs, "Asia/Shanghai"),
    ).toBe(false);
  });

  it("lists files from /nav-logs, filters by filename date, and skips stale stat entries", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: [
        "nav_2026-05-26_0.jsonl",
        "http_2026-05-26_0.jsonl",
        "nav_2026-05-24_0.jsonl",
        "nav_2026-05-26_1.jsonl",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(statDeviceFile).mockImplementation(async (_serial, path) =>
      path.endsWith("_1.jsonl") ? null : { mtimeMs: 1_779_000_000_000, sizeBytes: 123 },
    );

    const files = await poppoNavSource.listDeviceFiles(CTX);

    expect(runAdb).toHaveBeenCalledWith(
      [
        "-s",
        "FAKEDEV0",
        "shell",
        "ls",
        "-1",
        "/sdcard/Android/data/com.baitu.poppo/files/nav-logs",
      ],
      { timeoutMs: 8_000, allowNonZero: true },
    );
    expect(files).toEqual([
      {
        path: "/sdcard/Android/data/com.baitu.poppo/files/nav-logs/nav_2026-05-26_0.jsonl",
        name: "nav_2026-05-26_0.jsonl",
        mtimeMs: 1_779_000_000_000,
        sizeBytes: 123,
      },
    ]);
  });
});
