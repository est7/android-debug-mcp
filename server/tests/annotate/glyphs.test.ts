import { describe, expect, it } from "vitest";
import { DEFAULT_DIGIT_STYLE, DIGIT_SEGMENTS, measureNumber } from "../../src/annotate/glyphs.ts";

describe("DIGIT_SEGMENTS", () => {
  it("defines exactly 10 entries, one per digit 0-9", () => {
    expect(Object.keys(DIGIT_SEGMENTS).sort()).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });

  it("each digit's segment mask is length 7", () => {
    for (const [k, mask] of Object.entries(DIGIT_SEGMENTS)) {
      expect(mask).toHaveLength(7);
      // sanity: 0 lights 6 segments (no middle g), 8 lights all 7, 1 lights 2
      if (k === "0") expect(mask.filter(Boolean)).toHaveLength(6);
      if (k === "8") expect(mask.filter(Boolean)).toHaveLength(7);
      if (k === "1") expect(mask.filter(Boolean)).toHaveLength(2);
    }
  });
});

describe("measureNumber", () => {
  it("1-digit width == style.width + 0 gap", () => {
    expect(measureNumber(5, DEFAULT_DIGIT_STYLE, 4)).toEqual({ width: 24, height: 40 });
  });

  it("2-digit width includes one gap", () => {
    expect(measureNumber(23, DEFAULT_DIGIT_STYLE, 4)).toEqual({ width: 24 * 2 + 4, height: 40 });
  });

  it("3-digit width includes two gaps", () => {
    expect(measureNumber(100, DEFAULT_DIGIT_STYLE, 4)).toEqual({
      width: 24 * 3 + 4 * 2,
      height: 40,
    });
  });

  it("handles 0 as 1-digit", () => {
    expect(measureNumber(0, DEFAULT_DIGIT_STYLE, 4).width).toBe(24);
  });

  it("tolerates negative and non-integer input by taking abs(trunc(n))", () => {
    expect(measureNumber(-12, DEFAULT_DIGIT_STYLE, 4).width).toBe(24 * 2 + 4);
    expect(measureNumber(3.9, DEFAULT_DIGIT_STYLE, 4).width).toBe(24);
  });
});
