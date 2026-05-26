import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dispatchQuery } from "../../src/evidence/queryDispatch.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
  Profile,
} from "../../src/profile/types.ts";

/**
 * Q4 + Q11 contract for the per-source query dispatcher.
 *
 * The dispatcher does NOT touch I/O — it just resolves the source by id and
 * runs `source.querySchema.parse(query)`. These tests pin down the three
 * outcomes (`ok` / `soft_empty` / `malformed`) so Phase 4 sources can rely on
 * the same dispatch semantics without re-litigating Q11.
 */

function makeSource(id: string, querySchema: z.ZodTypeAny): EvidenceSource {
  return {
    id,
    querySchema,
    async listDeviceFiles(_ctx: EvidenceContext): Promise<readonly DeviceFileEntry[]> {
      return [];
    },
    async pullFile(_ctx: EvidenceContext, _df: DeviceFileEntry, _localPath: string) {
      // no-op
    },
    parseLine(_line: string): ParsedRecord | null {
      return null;
    },
    matchQuery(_record: ParsedRecord, _query: EvidenceQuery): boolean {
      return true;
    },
    redactForBundle(record: ParsedRecord): ParsedRecord {
      return record;
    },
  };
}

const fakeSrc = makeSource(
  "fake_src",
  z
    .object({
      source: z.literal("fake_src"),
      pathPrefix: z.string().optional(),
    })
    .strict(),
);

const profile: Profile = {
  name: "poppo-vone",
  evidenceSources: [fakeSrc],
};

describe("dispatchQuery", () => {
  it("vanilla session (profile === null) → soft_empty with explicit warning", () => {
    const r = dispatchQuery(null, { source: "fake_src" });
    expect(r.kind).toBe("soft_empty");
    if (r.kind === "soft_empty") {
      expect(r.warning).toContain("session has no profile loaded");
      expect(r.warning).toContain("fake_src");
    }
  });

  it("profile loaded but query.source not declared → soft_empty naming the source", () => {
    const r = dispatchQuery(profile, { source: "unknown_src" });
    expect(r.kind).toBe("soft_empty");
    if (r.kind === "soft_empty") {
      expect(r.warning).toContain("poppo-vone");
      expect(r.warning).toContain("unknown_src");
    }
  });

  it("source resolved and query shape valid → ok with parsedQuery", () => {
    const r = dispatchQuery(profile, { source: "fake_src", pathPrefix: "/api/v1" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.source.id).toBe("fake_src");
      expect(r.parsedQuery).toEqual({ source: "fake_src", pathPrefix: "/api/v1" });
    }
  });

  it("source resolved but schema rejects unknown key (.strict()) → malformed", () => {
    const r = dispatchQuery(profile, { source: "fake_src", junk: 1 });
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.error.code).toBe("query_malformed");
      expect(r.error.extra).toMatchObject({ source: "fake_src" });
      expect(r.error.message).toContain("fake_src");
    }
  });

  it("source resolved but a field has the wrong type → malformed", () => {
    const r = dispatchQuery(profile, { source: "fake_src", pathPrefix: 42 as unknown });
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.error.code).toBe("query_malformed");
      expect(r.error.message).toContain("pathPrefix");
    }
  });

  it("dispatch is pure: same input → same output, no side effects", () => {
    const q = { source: "fake_src", pathPrefix: "/p" };
    const a = dispatchQuery(profile, q);
    const b = dispatchQuery(profile, q);
    expect(a).toEqual(b);
    // Caller's query object is not mutated.
    expect(q).toEqual({ source: "fake_src", pathPrefix: "/p" });
  });
});
