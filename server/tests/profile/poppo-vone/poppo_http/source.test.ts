import { describe, expect, it } from "vitest";
import {
  poppoHttpSource,
  shouldKeepByFilenameDate,
} from "../../../../src/profile/poppo-vone/poppo_http/source.ts";
import type {
  EvidenceContext,
  EvidenceQuery,
  ParsedRecord,
} from "../../../../src/profile/types.ts";

/**
 * Unit tests for the poppo_http EvidenceSource — the pure paths only.
 * `listDeviceFiles` + `pullFile` need a live adb mock; those are exercised
 * by the search_evidence integration test (Phase 4 task (h)).
 */

const CTX_TYPICAL: EvidenceContext = {
  deviceSerial: "DEV0",
  packageName: "com.baitu.poppo",
  sessionStartMs: new Date("2026-05-26T05:30:00Z").getTime(),
  deviceTimezone: "Asia/Shanghai",
};

describe("shouldKeepByFilenameDate — filename-date filter with 1-day buffer", () => {
  it("rejects non-matching filenames", () => {
    expect(
      shouldKeepByFilenameDate("vlog_2026-05-26.log", CTX_TYPICAL.sessionStartMs, "Asia/Shanghai"),
    ).toBe(false);
    expect(shouldKeepByFilenameDate("README.md", CTX_TYPICAL.sessionStartMs, "Asia/Shanghai")).toBe(
      false,
    );
  });

  it("keeps current local-date file (Shanghai = UTC+8)", () => {
    // 2026-05-26 05:30 UTC = 2026-05-26 13:30 Shanghai → local date 2026-05-26
    expect(
      shouldKeepByFilenameDate(
        "http_2026-05-26_0.jsonl",
        CTX_TYPICAL.sessionStartMs,
        "Asia/Shanghai",
      ),
    ).toBe(true);
  });

  it("keeps yesterday-local file via 1-day buffer", () => {
    expect(
      shouldKeepByFilenameDate(
        "http_2026-05-25_3.jsonl",
        CTX_TYPICAL.sessionStartMs,
        "Asia/Shanghai",
      ),
    ).toBe(true);
  });

  it("rejects too-old file (more than 1 day before session-local-date)", () => {
    expect(
      shouldKeepByFilenameDate(
        "http_2026-05-24_0.jsonl",
        CTX_TYPICAL.sessionStartMs,
        "Asia/Shanghai",
      ),
    ).toBe(false);
  });

  it("keeps future-dated file (session straddles midnight → tomorrow allowed)", () => {
    expect(
      shouldKeepByFilenameDate(
        "http_2026-05-27_0.jsonl",
        CTX_TYPICAL.sessionStartMs,
        "Asia/Shanghai",
      ),
    ).toBe(true);
  });

  it("skips filtering when deviceTimezone is null — keeps all matching filenames", () => {
    expect(
      shouldKeepByFilenameDate("http_2020-01-01_0.jsonl", CTX_TYPICAL.sessionStartMs, null),
    ).toBe(true);
    expect(
      shouldKeepByFilenameDate("http_2030-01-01_99.jsonl", CTX_TYPICAL.sessionStartMs, null),
    ).toBe(true);
  });

  it("skips filtering when timezone is an unparseable string — fail-open", () => {
    expect(
      shouldKeepByFilenameDate(
        "http_2020-01-01_0.jsonl",
        CTX_TYPICAL.sessionStartMs,
        "Not/A/Real/Zone",
      ),
    ).toBe(true);
  });
});

/** Type-narrow the optional methods so each test calls them directly. */
function bindSession(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery {
  const fn = poppoHttpSource.bindSession;
  if (fn === undefined) throw new Error("poppoHttpSource.bindSession must be defined");
  return fn(query, ctx);
}
function sortKey(record: ParsedRecord): readonly (string | number)[] {
  const fn = poppoHttpSource.sortKey;
  if (fn === undefined) throw new Error("poppoHttpSource.sortKey must be defined");
  return fn(record);
}

describe("poppoHttpSource — bindSession (Phase 4 R1 + v2-G.1 Round 1 amendment)", () => {
  // v2-G.1 Round 1 amendment: bindSession only clamps when tsMsRange is
  // already present — it must NOT synthesize a partial range. The schema
  // also requires `{from,to}` both bounded with a 24h window cap.
  it("no synthesis: query without tsMsRange passes through unchanged", () => {
    const bound = bindSession({ source: "poppo_http" } as EvidenceQuery, CTX_TYPICAL);
    const tsMsRange = (bound as { tsMsRange?: { from: number; to: number } }).tsMsRange;
    expect(tsMsRange).toBeUndefined();
  });

  it("no synthesis: pathPrefix-only query passes through unchanged", () => {
    const bound = bindSession(
      { source: "poppo_http", pathPrefix: "/api/v1/users" } as EvidenceQuery,
      CTX_TYPICAL,
    );
    expect((bound as { tsMsRange?: unknown }).tsMsRange).toBeUndefined();
    expect((bound as unknown as { pathPrefix: string }).pathPrefix).toBe("/api/v1/users");
  });

  it("raises agent's tsMsRange.from to session floor when lower (keeps `to` intact)", () => {
    const userFrom = CTX_TYPICAL.sessionStartMs - 60_000;
    const userTo = CTX_TYPICAL.sessionStartMs + 60_000;
    const bound = bindSession(
      { source: "poppo_http", tsMsRange: { from: userFrom, to: userTo } } as EvidenceQuery,
      CTX_TYPICAL,
    );
    const tsMsRange = (bound as unknown as { tsMsRange: { from: number; to: number } }).tsMsRange;
    expect(tsMsRange.from).toBe(CTX_TYPICAL.sessionStartMs);
    expect(tsMsRange.to).toBe(userTo);
  });

  it("preserves agent's tsMsRange.from when already at or above floor", () => {
    const userFrom = CTX_TYPICAL.sessionStartMs + 10_000;
    const userTo = CTX_TYPICAL.sessionStartMs + 60_000;
    const bound = bindSession(
      { source: "poppo_http", tsMsRange: { from: userFrom, to: userTo } } as EvidenceQuery,
      CTX_TYPICAL,
    );
    const tsMsRange = (bound as unknown as { tsMsRange: { from: number; to: number } }).tsMsRange;
    expect(tsMsRange.from).toBe(userFrom);
    expect(tsMsRange.to).toBe(userTo);
  });
});

describe("poppoHttpSource — sortKey (codex Phase 4 audit R2)", () => {
  it("returns [tsMs, runId, seq] in schema-canonical order", () => {
    const record: ParsedRecord = {
      source: "poppo_http",
      tsMs: 1_716_600_000_000,
      runId: "1779260470000_18866",
      seq: 42,
    };
    expect(sortKey(record)).toEqual([1_716_600_000_000, "1779260470000_18866", 42]);
  });
});

describe("poppoHttpSource — id + querySchema discriminator", () => {
  it("id is 'poppo_http'", () => {
    expect(poppoHttpSource.id).toBe("poppo_http");
  });

  it("querySchema is strict on the source literal", () => {
    expect(() => poppoHttpSource.querySchema.parse({ source: "other_src" })).toThrow();
  });

  it("querySchema rejects unknown top-level keys", () => {
    expect(() => poppoHttpSource.querySchema.parse({ source: "poppo_http", junk: 1 })).toThrow();
  });

  it("querySchema accepts a fully-populated query", () => {
    const parsed = poppoHttpSource.querySchema.parse({
      source: "poppo_http",
      pathPrefix: "/users",
      methodIn: ["GET", "POST"],
      outcome: "app_error",
      excludeHeartbeat: true,
      tsMsRange: { from: 1000, to: 2000 },
      hostContains: "test-api",
      durationMsGte: 500,
      errorTypeIn: ["java.net.SocketTimeoutException"],
    });
    expect(parsed.source).toBe("poppo_http");
  });
});

describe("poppoHttpSource — validateNarrowingFilter (v0.4.0 Block A)", () => {
  // Calls a tiny wrapper so the test reads as "is this query narrowing?".
  const isNarrowing = (q: Record<string, unknown>): string | null =>
    poppoHttpSource.validateNarrowingFilter?.(q as EvidenceQuery) ?? null;

  it("bare {source} → underspecified message naming every accepted filter", () => {
    const msg = isNarrowing({ source: "poppo_http" });
    expect(msg).not.toBeNull();
    expect(msg).toContain("pathPrefix");
    expect(msg).toContain("methodIn");
    expect(msg).toContain("outcome");
    expect(msg).toContain("tsMsRange");
    expect(msg).toContain("hostContains");
    expect(msg).toContain("durationMsGte");
    expect(msg).toContain("errorTypeIn");
    // Steers the agent toward extract_evidence_context for "around an event".
    expect(msg).toContain("extract_evidence_context");
  });

  it("excludeHeartbeat alone is NOT narrowing (negative filter doesn't count)", () => {
    expect(isNarrowing({ source: "poppo_http", excludeHeartbeat: true })).not.toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["pathPrefix", { source: "poppo_http", pathPrefix: "/api" }],
    ["methodIn", { source: "poppo_http", methodIn: ["GET"] }],
    ["outcome", { source: "poppo_http", outcome: "http_error" }],
    ["tsMsRange", { source: "poppo_http", tsMsRange: { from: 0, to: 60_000 } }],
    ["hostContains", { source: "poppo_http", hostContains: "api.v.show" }],
    ["durationMsGte", { source: "poppo_http", durationMsGte: 1000 }],
    ["errorTypeIn", { source: "poppo_http", errorTypeIn: ["java.io.IOException"] }],
  ])("%s alone is narrowing → accepts", (_label, q) => {
    expect(isNarrowing(q)).toBeNull();
  });

  it("a positive filter combined with excludeHeartbeat is still narrowing", () => {
    expect(
      isNarrowing({ source: "poppo_http", pathPrefix: "/api", excludeHeartbeat: true }),
    ).toBeNull();
  });
});
