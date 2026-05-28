/**
 * Programmatic 7-segment digit renderer for badge labels.
 *
 * Decision: glyph shape is a pure function of (digit, size), no atlas / TTF /
 * font file loading. Source of truth: design lock § Q7 and the spike-validated
 * 7-segment layout below.
 *
 *      ┌─ a ─┐
 *     f│     │b
 *      ├─ g ─┤
 *     e│     │c
 *      └─ d ─┘
 *
 * Each digit is described by which segments are lit (index = a..g). The
 * actual pixel painting lives in {@link paint.ts}; this module is intentionally
 * data-only so it stays bun --compile-safe (no font assets, no path resolution).
 */

/** Segment letters in fixed order: [a, b, c, d, e, f, g]. */
export type SegmentMask = readonly [boolean, boolean, boolean, boolean, boolean, boolean, boolean];

/** Width / height / segment-thickness in pixels for one rendered digit. */
export interface DigitStyle {
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
}

/** Lookup map: char "0".."9" → segment mask. */
export const DIGIT_SEGMENTS: Readonly<Record<string, SegmentMask>> = {
  "0": [true, true, true, true, true, true, false],
  "1": [false, true, true, false, false, false, false],
  "2": [true, true, false, true, true, false, true],
  "3": [true, true, true, true, false, false, true],
  "4": [false, true, true, false, false, true, true],
  "5": [true, false, true, true, false, true, true],
  "6": [true, false, true, true, true, true, true],
  "7": [true, true, true, false, false, false, false],
  "8": [true, true, true, true, true, true, true],
  "9": [true, true, true, true, false, true, true],
};

/** Default badge digit style. Tuned in 2026-05-27 spike on Poppo 1080×2400 fixture. */
export const DEFAULT_DIGIT_STYLE: DigitStyle = { width: 24, height: 40, thickness: 6 };

/**
 * Width consumed by `num` rendered with `style`, joined by `gap` px between
 * consecutive digits. `Math.abs` so callers can hand negative ints without an
 * NaN result; the badge layout always wants a non-negative width.
 */
export function measureNumber(
  num: number,
  style: DigitStyle,
  gap: number,
): {
  readonly width: number;
  readonly height: number;
} {
  const digits = String(Math.abs(Math.trunc(num)));
  const n = digits.length;
  return { width: n * style.width + Math.max(0, n - 1) * gap, height: style.height };
}

/**
 * v2-F.2 — ASCII bitmap atlas for badge labels (A-Z, a-z, 0-9, `:` = 63 chars).
 *
 * Each glyph is 5 px wide × 7 px tall at native scale. The 7-element row array
 * encodes each row as a 5-bit number, MSB = leftmost column (col 0). The
 * `g(...)` helper parses each row as binary so the bitmap is visible in source.
 *
 * Per design lock § F2-Q5 (Round 1 fold-in): plain `number[]` per row (not
 * `bigint[]`); 5 bits fits in a JS number, tests assert numeric bitmasks
 * directly. 63 chars × 7 rows × 4 bytes ≈ 1.7 KB pure data, bun --compile
 * friendly (no IO, no atlas asset file).
 */

function g(rows: string): readonly number[] {
  return rows
    .trim()
    .split(/\s+/)
    .map((row) => Number.parseInt(row, 2));
}

export const ASCII_GLYPHS: Readonly<Record<string, readonly number[]>> = {
  // ── Uppercase A-Z ───────────────────────────────────────────────────────
  A: g("01110 10001 10001 11111 10001 10001 10001"),
  B: g("11110 10001 10001 11110 10001 10001 11110"),
  C: g("01111 10000 10000 10000 10000 10000 01111"),
  D: g("11110 10001 10001 10001 10001 10001 11110"),
  E: g("11111 10000 10000 11110 10000 10000 11111"),
  F: g("11111 10000 10000 11110 10000 10000 10000"),
  G: g("01111 10000 10000 10111 10001 10001 01110"),
  H: g("10001 10001 10001 11111 10001 10001 10001"),
  I: g("11111 00100 00100 00100 00100 00100 11111"),
  J: g("11111 00001 00001 00001 00001 10001 01110"),
  K: g("10001 10010 10100 11000 10100 10010 10001"),
  L: g("10000 10000 10000 10000 10000 10000 11111"),
  M: g("10001 11011 10101 10101 10001 10001 10001"),
  N: g("10001 11001 10101 10011 10001 10001 10001"),
  O: g("01110 10001 10001 10001 10001 10001 01110"),
  P: g("11110 10001 10001 11110 10000 10000 10000"),
  Q: g("01110 10001 10001 10001 10101 10010 01101"),
  R: g("11110 10001 10001 11110 10100 10010 10001"),
  S: g("01111 10000 10000 01110 00001 00001 11110"),
  T: g("11111 00100 00100 00100 00100 00100 00100"),
  U: g("10001 10001 10001 10001 10001 10001 01110"),
  V: g("10001 10001 10001 10001 10001 01010 00100"),
  W: g("10001 10001 10001 10101 10101 10101 01010"),
  X: g("10001 10001 01010 00100 01010 10001 10001"),
  Y: g("10001 10001 01010 00100 00100 00100 00100"),
  Z: g("11111 00001 00010 00100 01000 10000 11111"),
  // ── Lowercase a-z ───────────────────────────────────────────────────────
  a: g("00000 00000 01110 00001 01111 10001 01111"),
  b: g("10000 10000 11110 10001 10001 10001 11110"),
  c: g("00000 00000 01111 10000 10000 10000 01111"),
  d: g("00001 00001 01111 10001 10001 10001 01111"),
  e: g("00000 00000 01110 10001 11111 10000 01111"),
  f: g("00110 01001 01000 11100 01000 01000 01000"),
  g: g("00000 01111 10001 01111 00001 00001 01110"),
  h: g("10000 10000 11110 10001 10001 10001 10001"),
  i: g("00100 00000 00100 00100 00100 00100 00100"),
  j: g("00001 00000 00001 00001 00001 10001 01110"),
  k: g("10000 10000 10010 10100 11000 10100 10010"),
  l: g("01100 00100 00100 00100 00100 00100 01110"),
  m: g("00000 00000 11010 10101 10101 10101 10001"),
  n: g("00000 00000 11110 10001 10001 10001 10001"),
  o: g("00000 00000 01110 10001 10001 10001 01110"),
  p: g("00000 11110 10001 10001 11110 10000 10000"),
  q: g("00000 01111 10001 10001 01111 00001 00001"),
  r: g("00000 00000 10110 11001 10000 10000 10000"),
  s: g("00000 00000 01111 10000 01110 00001 11110"),
  t: g("01000 01000 11100 01000 01000 01001 00110"),
  u: g("00000 00000 10001 10001 10001 10001 01111"),
  v: g("00000 00000 10001 10001 10001 01010 00100"),
  w: g("00000 00000 10001 10001 10101 10101 01010"),
  x: g("00000 00000 10001 01010 00100 01010 10001"),
  y: g("00000 10001 10001 01111 00001 00001 01110"),
  z: g("00000 00000 11111 00010 00100 01000 11111"),
  // ── Digits 0-9 (atlas variant; distinct from the 7-segment digit ───────
  //     renderer DIGIT_SEGMENTS — these are only used in ASCII text, not
  //     in the big numeric badge id). ──────────────────────────────────────
  "0": g("01110 10001 10011 10101 11001 10001 01110"),
  "1": g("00100 01100 00100 00100 00100 00100 01110"),
  "2": g("01110 10001 00001 00010 00100 01000 11111"),
  "3": g("01110 10001 00001 00110 00001 10001 01110"),
  "4": g("00010 00110 01010 10010 11111 00010 00010"),
  "5": g("11111 10000 11110 00001 00001 10001 01110"),
  "6": g("00110 01000 10000 11110 10001 10001 01110"),
  "7": g("11111 00001 00010 00100 01000 01000 01000"),
  "8": g("01110 10001 10001 01110 10001 10001 01110"),
  "9": g("01110 10001 10001 01111 00001 00010 01100"),
  // ── Punctuation ─────────────────────────────────────────────────────────
  ":": g("00000 00100 00000 00000 00000 00100 00000"),
};

export const GLYPH_NATIVE_WIDTH = 5;
export const GLYPH_NATIVE_HEIGHT = 7;

/**
 * Default badge label style — 2× scale on the 5×7 native atlas yields 10×14
 * letter cells; with `GLYPH_GAP=2` per inter-char gap the typical 8-char
 * truncated label ("EditText", "FrameLay") occupies 8×10 + 7×2 = 94 px.
 * Stays comfortably under a 200 px badge width target on 1080 px viewports.
 */
export const DEFAULT_LABEL_SCALE = 2;
export const GLYPH_GAP = 2;

/**
 * Measure a string `s` painted at `scale` on the ASCII atlas; same `{width,
 * height}` shape as `measureNumber` so callers can sum mixed-renderer widths
 * without type juggling (design lock § F2-Q6).
 *
 * Unknown chars contribute zero width — caller upstream (`classShortLabel`)
 * should already have filtered to atlas keys.
 */
export function measureText(
  s: string,
  scale: number = DEFAULT_LABEL_SCALE,
): {
  readonly width: number;
  readonly height: number;
} {
  const w = GLYPH_NATIVE_WIDTH * scale;
  const h = GLYPH_NATIVE_HEIGHT * scale;
  const n = s.length;
  if (n === 0) return { width: 0, height: h };
  return { width: n * w + Math.max(0, n - 1) * GLYPH_GAP, height: h };
}
