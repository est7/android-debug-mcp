import { PNG } from "pngjs";
import {
  ASCII_GLYPHS,
  DEFAULT_LABEL_SCALE,
  DIGIT_SEGMENTS,
  type DigitStyle,
  GLYPH_GAP,
  GLYPH_NATIVE_HEIGHT,
  GLYPH_NATIVE_WIDTH,
  type SegmentMask,
} from "./glyphs.ts";

/**
 * Maximum decoded pixel count. 4096² = 16,777,216 — covers the Poppo / Vone /
 * popposhell target device set with margin (their tallest screencap to date is
 * 1080 × 2400 ≈ 2.6 M). 8K (33 MP) would be rejected; that band of device is
 * not in our test fleet. design lock § Open implementation decisions.
 */
export const MAX_PIXELS = 16_777_216;
/** PNG IHDR sits at fixed offset; first 29 bytes carry everything the guard needs. */
export const IHDR_HEADER_BYTES = 29;

/** Tuple `[r, g, b, a]` 0..255. */
export type RGBA = readonly [number, number, number, number];

export interface ImageBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

/**
 * Public soft-degrade codes that `capture.annotation.error` may surface (design
 * lock § 失败语义). Narrowing the type prevents an internal-only string from
 * silently becoming part of the public contract (codex post-impl audit #1).
 * `annotate_elements_unavailable` is owned by `CollectElementsError` mapping
 * in the capture handler, not by AnnotateError.
 */
export type AnnotateErrorCode = "annotate_decode_failed" | "annotate_image_too_large";

export class AnnotateError extends Error {
  readonly code: AnnotateErrorCode;
  constructor(code: AnnotateErrorCode, message: string) {
    super(message);
    this.name = "AnnotateError";
    this.code = code;
  }
}

/**
 * Pre-decode IHDR sniff. Reads `width`, `height`, `bitDepth`, `colorType` from
 * the PNG header (offset 8 — magic ends — through offset 24) and rejects
 * anything over {@link MAX_PIXELS} (decode-bomb guard) or with unreasonable
 * channel / bit-depth settings BEFORE allocating the full image buffer. design
 * lock § "PNG decode-bomb guard" requirement.
 */
export function inspectPngHeader(buf: Buffer): {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
} {
  if (buf.length < IHDR_HEADER_BYTES) {
    throw new AnnotateError("annotate_decode_failed", "PNG buffer too short for IHDR.");
  }
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A (8 bytes)
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== magic[i]) {
      throw new AnnotateError("annotate_decode_failed", "Not a PNG (bad signature).");
    }
  }
  // After signature: 4B chunk length (BE) + 4B chunk type ("IHDR") + 13B data.
  // Validate the chunk type so we don't trust width/height from a foreign chunk.
  const chunkType = buf.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR") {
    throw new AnnotateError("annotate_decode_failed", "First chunk is not IHDR.");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24] ?? 0;
  const colorType = buf[25] ?? 0;
  if (width <= 0 || height <= 0) {
    throw new AnnotateError(
      "annotate_decode_failed",
      `PNG dimensions invalid (${width}×${height}).`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new AnnotateError(
      "annotate_image_too_large",
      `PNG ${width}×${height} exceeds MAX_PIXELS (${MAX_PIXELS}).`,
    );
  }
  if (bitDepth > 16) {
    throw new AnnotateError("annotate_image_too_large", `PNG bitDepth ${bitDepth} > 16.`);
  }
  // colorType: 0=gray, 2=RGB, 3=palette, 4=gray+alpha, 6=RGBA. 6 = 4 channels max.
  if (![0, 2, 3, 4, 6].includes(colorType)) {
    throw new AnnotateError("annotate_decode_failed", `PNG colorType ${colorType} unsupported.`);
  }
  return { width, height, bitDepth, colorType };
}

/** Decode a PNG buffer to RGBA, guarded by {@link inspectPngHeader}. */
export function decodePng(buf: Buffer): ImageBuffer {
  inspectPngHeader(buf);
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

/** Encode RGBA back to PNG bytes. */
export function encodePng(img: ImageBuffer): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

/** In-place clipped pixel write. Out-of-bound coords silently no-op. */
function setPixel(img: ImageBuffer, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const idx = (y * img.width + x) * 4;
  img.data[idx] = c[0];
  img.data[idx + 1] = c[1];
  img.data[idx + 2] = c[2];
  img.data[idx + 3] = c[3];
}

/** Fill rect [l, t) × [r, b), clipped to image. */
export function fillRect(
  img: ImageBuffer,
  l: number,
  t: number,
  r: number,
  b: number,
  c: RGBA,
): void {
  const x0 = Math.max(0, Math.floor(l));
  const y0 = Math.max(0, Math.floor(t));
  const x1 = Math.min(img.width, Math.ceil(r));
  const y1 = Math.min(img.height, Math.ceil(b));
  for (let y = y0; y < y1; y++) {
    let idx = (y * img.width + x0) * 4;
    for (let x = x0; x < x1; x++) {
      img.data[idx] = c[0];
      img.data[idx + 1] = c[1];
      img.data[idx + 2] = c[2];
      img.data[idx + 3] = c[3];
      idx += 4;
    }
  }
}

/** Outline rect [l, t, r, b] with given pixel `thickness`. */
export function strokeRect(
  img: ImageBuffer,
  l: number,
  t: number,
  r: number,
  b: number,
  c: RGBA,
  thickness: number,
): void {
  fillRect(img, l, t, r, t + thickness, c);
  fillRect(img, l, b - thickness, r, b, c);
  fillRect(img, l, t, l + thickness, b, c);
  fillRect(img, r - thickness, t, r, b, c);
}

/** Draw one digit glyph at (x, y) with `style` (top-left anchored). */
export function drawDigit(
  img: ImageBuffer,
  x: number,
  y: number,
  digit: string,
  style: DigitStyle,
  c: RGBA,
): void {
  const segs: SegmentMask | undefined = DIGIT_SEGMENTS[digit];
  if (!segs) return;
  const { width, height, thickness } = style;
  const midY = Math.floor((height - thickness) / 2);
  if (segs[0]) fillRect(img, x, y, x + width, y + thickness, c);
  if (segs[3]) fillRect(img, x, y + height - thickness, x + width, y + height, c);
  if (segs[6]) fillRect(img, x, y + midY, x + width, y + midY + thickness, c);
  if (segs[5]) fillRect(img, x, y, x + thickness, y + midY + thickness, c);
  if (segs[1]) fillRect(img, x + width - thickness, y, x + width, y + midY + thickness, c);
  if (segs[4]) fillRect(img, x, y + midY, x + thickness, y + height, c);
  if (segs[2]) fillRect(img, x + width - thickness, y + midY, x + width, y + height, c);
}

/** Draw a non-negative integer at (x, y), digits laid horizontally with `gap`. */
export function drawNumber(
  img: ImageBuffer,
  x: number,
  y: number,
  num: number,
  style: DigitStyle,
  gap: number,
  c: RGBA,
): void {
  const digits = String(Math.abs(Math.trunc(num)));
  let cursor = x;
  for (const ch of digits) {
    drawDigit(img, cursor, y, ch, style, c);
    cursor += style.width + gap;
  }
}

/**
 * v2-F.2 — render one ASCII glyph at (x, y), `scale` px per native bit, in
 * `color`. Unknown chars (not in `ASCII_GLYPHS`) silently no-op so a single
 * exotic char in a class name doesn't break the whole label paint pass.
 * `setPixel` is intentionally not called — every `1` in the row mask is
 * stamped as a `scale × scale` filled square via `fillRect`, which already
 * clips to image bounds.
 */
export function drawChar(
  img: ImageBuffer,
  x: number,
  y: number,
  ch: string,
  scale: number,
  c: RGBA,
): void {
  const rows = ASCII_GLYPHS[ch];
  if (rows === undefined) return;
  for (let row = 0; row < rows.length; row++) {
    const mask = rows[row] ?? 0;
    for (let col = 0; col < GLYPH_NATIVE_WIDTH; col++) {
      // MSB = leftmost column (col 0).
      const bit = (mask >> (GLYPH_NATIVE_WIDTH - 1 - col)) & 1;
      if (bit === 1) {
        const px = x + col * scale;
        const py = y + row * scale;
        fillRect(img, px, py, px + scale, py + scale, c);
      }
    }
  }
}

/**
 * v2-F.2 — render a string of ASCII glyphs at (x, y), `scale` px per native
 * bit, gap **unscaled** `GLYPH_GAP` px between consecutive chars (v0.5.5
 * audit advisory #1 — comment said `GLYPH_GAP * scale` but impl is
 * unscaled, and `measureText` + the 94 px "EditText" lock both depend on
 * the unscaled value). Mirrors {@link drawNumber} for the digit renderer.
 * Cursor advances by `5 * scale + GLYPH_GAP` per char regardless of
 * whether the char is in the atlas, so spacing stays uniform when a
 * class name has an unknown char.
 */
export function drawText(
  img: ImageBuffer,
  x: number,
  y: number,
  s: string,
  scale: number,
  c: RGBA,
): void {
  let cursor = x;
  for (const ch of s) {
    drawChar(img, cursor, y, ch, scale, c);
    cursor += GLYPH_NATIVE_WIDTH * scale + GLYPH_GAP;
  }
}

// setPixel is intentionally not exported — primitive consumer is fillRect.
void setPixel;
// Re-export glyph constants for callers that want to compose layouts without
// double-importing glyphs.ts.
export { DEFAULT_LABEL_SCALE, GLYPH_GAP, GLYPH_NATIVE_HEIGHT, GLYPH_NATIVE_WIDTH };
void GLYPH_NATIVE_HEIGHT;
void DEFAULT_LABEL_SCALE;
