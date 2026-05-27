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
