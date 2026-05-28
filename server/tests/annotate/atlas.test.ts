import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPHS,
  DEFAULT_LABEL_SCALE,
  GLYPH_GAP,
  GLYPH_NATIVE_HEIGHT,
  GLYPH_NATIVE_WIDTH,
  measureText,
} from "../../src/annotate/glyphs.ts";

/**
 * v2-F.2 Phase 1 — ASCII atlas unit coverage.
 *
 * Verifies the 63-glyph inventory, native dimensions, MSB-encoded bitmap
 * shape, and `measureText` linear layout (`n × charW + (n-1) × gap`). Per
 * design lock § F2-Q5 the atlas type is `Readonly<Record<string, readonly
 * number[]>>` with 5-bit rows; these tests pin the bit ordering so
 * `drawChar` in paint.ts can rely on MSB-first reads.
 */

describe("ASCII_GLYPHS — inventory + dimensions", () => {
  it("contains exactly 63 glyphs (A-Z + a-z + 0-9 + ':')", () => {
    const keys = Object.keys(ASCII_GLYPHS);
    expect(keys).toHaveLength(63);
  });

  it("covers uppercase A-Z", () => {
    for (let c = 65; c <= 90; c++) {
      const ch = String.fromCharCode(c);
      expect(ASCII_GLYPHS[ch]).toBeDefined();
    }
  });

  it("covers lowercase a-z", () => {
    for (let c = 97; c <= 122; c++) {
      const ch = String.fromCharCode(c);
      expect(ASCII_GLYPHS[ch]).toBeDefined();
    }
  });

  it("covers digits 0-9", () => {
    for (let d = 0; d <= 9; d++) {
      expect(ASCII_GLYPHS[String(d)]).toBeDefined();
    }
  });

  it("covers ':' separator", () => {
    expect(ASCII_GLYPHS[":"]).toBeDefined();
  });

  it("does NOT include space", () => {
    expect(ASCII_GLYPHS[" "]).toBeUndefined();
  });

  it("every glyph is 7 rows of 5-bit values (0..31)", () => {
    for (const [ch, rows] of Object.entries(ASCII_GLYPHS)) {
      expect(rows, `glyph '${ch}' rows`).toHaveLength(7);
      for (const r of rows) {
        expect(r, `glyph '${ch}' row`).toBeGreaterThanOrEqual(0);
        expect(r, `glyph '${ch}' row`).toBeLessThanOrEqual(31); // 5 bits
        expect(Number.isInteger(r), `glyph '${ch}' row int`).toBe(true);
      }
    }
  });

  it("native dimensions are 5 × 7", () => {
    expect(GLYPH_NATIVE_WIDTH).toBe(5);
    expect(GLYPH_NATIVE_HEIGHT).toBe(7);
  });
});

describe("ASCII_GLYPHS — MSB-first bit ordering spot checks", () => {
  // Each row is 5 bits; col 0 is MSB. `A`'s top row `.XXX.` should be 01110.
  it("A row 0 matches the visual `.XXX.`", () => {
    const rows = ASCII_GLYPHS.A as readonly number[];
    expect(rows[0]).toBe(0b01110);
  });

  it("A row 3 is the crossbar `XXXXX`", () => {
    const rows = ASCII_GLYPHS.A as readonly number[];
    expect(rows[3]).toBe(0b11111);
  });

  it("':' has two dots only (row 1 + row 5 = 0b00100)", () => {
    const rows = ASCII_GLYPHS[":"] as readonly number[];
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBe(0b00100);
    expect(rows[2]).toBe(0);
    expect(rows[3]).toBe(0);
    expect(rows[4]).toBe(0);
    expect(rows[5]).toBe(0b00100);
    expect(rows[6]).toBe(0);
  });

  it("'I' uppercase has top + bottom crossbars (atlas 0/6 = 0b11111)", () => {
    const rows = ASCII_GLYPHS.I as readonly number[];
    expect(rows[0]).toBe(0b11111);
    expect(rows[6]).toBe(0b11111);
  });
});

describe("measureText — linear layout matches design lock § F2-Q6", () => {
  it("empty string → width 0, height = 7 × scale", () => {
    const m = measureText("", DEFAULT_LABEL_SCALE);
    expect(m.width).toBe(0);
    expect(m.height).toBe(GLYPH_NATIVE_HEIGHT * DEFAULT_LABEL_SCALE);
  });

  it("single char → width = 5 × scale, height = 7 × scale", () => {
    const m = measureText("A", DEFAULT_LABEL_SCALE);
    expect(m.width).toBe(GLYPH_NATIVE_WIDTH * DEFAULT_LABEL_SCALE);
    expect(m.height).toBe(GLYPH_NATIVE_HEIGHT * DEFAULT_LABEL_SCALE);
  });

  it("8 chars at default scale → 8 × 10 + 7 × 2 = 94 (lock-cited number)", () => {
    const m = measureText("EditText", DEFAULT_LABEL_SCALE);
    expect(m.width).toBe(8 * (GLYPH_NATIVE_WIDTH * 2) + 7 * GLYPH_GAP);
    expect(m.width).toBe(94);
  });

  it("scale=1 (native) → no inter-char doubling", () => {
    const m = measureText("ABC", 1);
    expect(m.width).toBe(3 * 5 + 2 * GLYPH_GAP);
    expect(m.height).toBe(7);
  });

  it("returns `.width` field (not `.w`) — Round 1 amendment alignment with measureNumber", () => {
    const m = measureText("X", DEFAULT_LABEL_SCALE);
    expect("width" in m).toBe(true);
    expect("w" in m).toBe(false);
  });
});
