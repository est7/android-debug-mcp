import { describe, expect, it } from "vitest";
import { POPPO_VONE_PROFILE } from "../../../../src/profile/poppo-vone/index.ts";

describe("poppo-vone profile — poppo_nav registration", () => {
  it("registers poppo_nav alongside poppo_http", () => {
    expect(POPPO_VONE_PROFILE.evidenceSources.map((s) => s.id)).toEqual([
      "poppo_http",
      "poppo_nav",
    ]);
  });
});
