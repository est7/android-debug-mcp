import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { type AnnotateInput, annotatePng } from "../../src/annotate/annotate.ts";
import { decodePng } from "../../src/annotate/paint.ts";

function blankPng(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 0;
    png.data[i + 2] = 0;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png);
}

describe("annotatePng", () => {
  it("returns a PNG of the same dimensions as input", () => {
    const input = blankPng(200, 300);
    const result = annotatePng(input, [
      { annotationId: 1, bounds: { l: 10, t: 10, r: 100, b: 100 } },
    ]);
    const decoded = decodePng(result.png);
    expect(decoded.width).toBe(200);
    expect(decoded.height).toBe(300);
    expect(result.elementCount).toBe(1);
  });

  it("paints at least one non-background pixel for each element", () => {
    const input = blankPng(400, 400);
    const elements: AnnotateInput[] = [
      { annotationId: 1, bounds: { l: 10, t: 10, r: 200, b: 200 } },
      { annotationId: 2, bounds: { l: 220, t: 10, r: 380, b: 200 } },
    ];
    const result = annotatePng(input, elements);
    const decoded = decodePng(result.png);
    // Confirm some non-black pixels exist in each element's bbox region.
    function hasNonBlack(l: number, t: number, r: number, b: number): boolean {
      for (let y = t; y < b; y++) {
        for (let x = l; x < r; x++) {
          const idx = (y * decoded.width + x) * 4;
          if (
            decoded.data[idx] !== 0 ||
            decoded.data[idx + 1] !== 0 ||
            decoded.data[idx + 2] !== 0
          ) {
            return true;
          }
        }
      }
      return false;
    }
    expect(hasNonBlack(10, 10, 200, 200)).toBe(true);
    expect(hasNonBlack(220, 10, 380, 200)).toBe(true);
  });

  it("returns elementCount = 0 for empty input — annotate.ts re-encodes; byte-identical guarantee lives at the capture-layer S2 path", () => {
    const input = blankPng(100, 100);
    const result = annotatePng(input, []);
    expect(result.elementCount).toBe(0);
    // Same dimensions; pixel data may be re-encoded but logical content equal.
    const decoded = decodePng(result.png);
    expect(decoded.width).toBe(100);
    expect(decoded.height).toBe(100);
    let nonZero = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i] !== 0 || decoded.data[i + 1] !== 0 || decoded.data[i + 2] !== 0) {
        nonZero++;
      }
    }
    expect(nonZero).toBe(0);
  });

  it("handles 3-digit annotationId (badge fallback path)", () => {
    const input = blankPng(400, 400);
    const result = annotatePng(input, [
      { annotationId: 100, bounds: { l: 20, t: 20, r: 380, b: 380 } },
    ]);
    expect(result.elementCount).toBe(1);
    const decoded = decodePng(result.png);
    // 3-digit badge has measurable width; spot-check that *some* digit pixels landed
    // somewhere reasonable (the badge top-left anchored inside the bbox).
    let painted = 0;
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i] !== 0) painted++;
    }
    expect(painted).toBeGreaterThan(50); // 3 digits worth of segments + box stroke
  });

  it("propagates AnnotateError from a bad PNG input", () => {
    const garbage = Buffer.from("not a png at all but long enough to exceed the IHDR offset");
    expect(() => annotatePng(garbage, [])).toThrowError(
      expect.objectContaining({ name: "AnnotateError" }),
    );
  });

  it("placement rule: small bbox sends badge to outside fallback", () => {
    // 30×40 bbox is smaller than 2× badge size (badge ≈ 44×56 for 1-digit) →
    // fallback to outside top-left, clamped to viewport top.
    const input = blankPng(200, 200);
    const result = annotatePng(input, [
      { annotationId: 7, bounds: { l: 50, t: 80, r: 80, b: 120 } },
    ]);
    const decoded = decodePng(result.png);
    // The badge should sit ABOVE the bbox (between y ~24 and y ~80).
    // Sanity: y=70 row at x=50..100 should have some painted pixels.
    let aboveBoxPainted = 0;
    for (let y = 20; y < 80; y++) {
      for (let x = 50; x < 100; x++) {
        const idx = (y * decoded.width + x) * 4;
        if (decoded.data[idx] !== 0) aboveBoxPainted++;
      }
    }
    expect(aboveBoxPainted).toBeGreaterThan(10);
  });

  it("placement rule: large bbox keeps badge inside top-left", () => {
    // 400×400 bbox in 500×500 image, 1-digit badge ≈ 44×56 → fits inside (< 200×200).
    const input = blankPng(500, 500);
    const result = annotatePng(input, [
      { annotationId: 1, bounds: { l: 50, t: 50, r: 450, b: 450 } },
    ]);
    const decoded = decodePng(result.png);
    // Badge anchor at (50+6, 50+6) = (56, 56). Some painted pixels near (60, 60).
    let inBoxPainted = 0;
    for (let y = 55; y < 110; y++) {
      for (let x = 55; x < 105; x++) {
        const idx = (y * decoded.width + x) * 4;
        if (decoded.data[idx] !== 0) inBoxPainted++;
      }
    }
    expect(inBoxPainted).toBeGreaterThan(20);
  });
});
