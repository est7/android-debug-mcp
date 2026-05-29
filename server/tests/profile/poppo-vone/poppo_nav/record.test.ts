import { describe, expect, it } from "vitest";
import { parsePoppoNavLine } from "../../../../src/profile/poppo-vone/poppo_nav/record.ts";

describe("parsePoppoNavLine", () => {
  it("stamps source and preserves passthrough fields", () => {
    const record = parsePoppoNavLine(
      JSON.stringify({
        v: 1,
        tsMs: 1_779_000_000_001,
        type: "open",
        name: "Home",
        host: "MainActivity",
        routeId: "home-tab",
      }),
    );

    expect(record).toEqual({
      source: "poppo_nav",
      v: 1,
      tsMs: 1_779_000_000_001,
      type: "open",
      name: "Home",
      host: "MainActivity",
      routeId: "home-tab",
    });
  });

  it("accepts records without optional v and host", () => {
    expect(
      parsePoppoNavLine(JSON.stringify({ tsMs: 1_779_000_000_002, type: "tap", name: "Profile" })),
    ).toEqual({
      source: "poppo_nav",
      tsMs: 1_779_000_000_002,
      type: "tap",
      name: "Profile",
    });
  });

  it("returns null for malformed JSON and invalid shapes", () => {
    expect(parsePoppoNavLine("{")).toBeNull();
    expect(parsePoppoNavLine(JSON.stringify({ v: 2, tsMs: 1, type: "open", name: "Home" }))).toBe(
      null,
    );
    expect(parsePoppoNavLine(JSON.stringify({ tsMs: 1, type: "open" }))).toBeNull();
  });
});
