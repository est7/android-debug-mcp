import { DEFAULT_DIGIT_STYLE, measureNumber } from "./glyphs.ts";
import {
  AnnotateError,
  type ImageBuffer,
  type RGBA,
  decodePng,
  drawNumber,
  encodePng,
  fillRect,
  strokeRect,
} from "./paint.ts";

const WHITE: RGBA = [0xff, 0xff, 0xff, 0xff];

/**
 * Badge palette. 10 high-contrast hues cycled by index. Hand-tuned for WCAG AA
 * contrast (≥ 4.5:1) against the white digit fill — design lock § Q8.
 */
const PALETTE: ReadonlyArray<RGBA> = [
  [0xff, 0x00, 0x44, 0xff],
  [0x00, 0xcc, 0x66, 0xff],
  [0xff, 0x88, 0x00, 0xff],
  [0x99, 0x33, 0xff, 0xff],
  [0x00, 0xbb, 0xdd, 0xff],
  [0xdd, 0x22, 0x66, 0xff],
  [0x44, 0xaa, 0x00, 0xff],
  [0xee, 0x55, 0x00, 0xff],
  [0x66, 0x44, 0xaa, 0xff],
  [0x00, 0x88, 0x66, 0xff],
];

const BADGE_PAD_X = 10;
const BADGE_PAD_Y = 8;
const BADGE_GAP = 4;
const BBOX_STROKE = 4;
const BADGE_INSET = 6;

/**
 * What annotate needs per element. Subset of v2-F.0 Element: only `bounds.{l,t,r,b}`
 * (already projected to the painter's short-key local form by the caller). The
 * caller (`capture` handler) is responsible for mapping each Element → this
 * minimal shape so the renderer stays decoupled from the public Element schema.
 */
export interface AnnotateInput {
  readonly annotationId: number;
  readonly bounds: {
    readonly l: number;
    readonly t: number;
    readonly r: number;
    readonly b: number;
  };
}

export interface AnnotateResult {
  readonly png: Buffer;
  readonly elementCount: number;
}

function colorAt(i: number): RGBA {
  return PALETTE[i % PALETTE.length] ?? ([0xff, 0, 0, 0xff] as const);
}

/**
 * Decide badge anchor. Default: inside top-left with {@link BADGE_INSET} px
 * inset. Fallback: outside top-left clamped to viewport when badge would
 * occupy > 0.5 × bbox dimension. design lock § Q9.
 */
function placeBadge(
  bboxL: number,
  bboxT: number,
  bboxR: number,
  bboxB: number,
  badgeW: number,
  badgeH: number,
): { readonly l: number; readonly t: number; readonly mode: "inside" | "outside" } {
  const bboxW = bboxR - bboxL;
  const bboxH = bboxB - bboxT;
  const fitsInside =
    badgeW + BADGE_INSET * 2 <= bboxW * 0.5 && badgeH + BADGE_INSET * 2 <= bboxH * 0.5;
  if (fitsInside) {
    return { l: bboxL + BADGE_INSET, t: bboxT + BADGE_INSET, mode: "inside" };
  }
  return { l: bboxL, t: Math.max(0, bboxT - badgeH), mode: "outside" };
}

/** Paint boxes + numbered badges in-place. */
function paint(img: ImageBuffer, elements: ReadonlyArray<AnnotateInput>): void {
  const digitStyle = DEFAULT_DIGIT_STYLE;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    const { l, t, r, b } = el.bounds;
    const color = colorAt(i);
    strokeRect(img, l, t, r, b, color, BBOX_STROKE);
    const sz = measureNumber(el.annotationId, digitStyle, BADGE_GAP);
    const badgeW = sz.width + BADGE_PAD_X * 2;
    const badgeH = sz.height + BADGE_PAD_Y * 2;
    const pos = placeBadge(l, t, r, b, badgeW, badgeH);
    fillRect(img, pos.l, pos.t, pos.l + badgeW, pos.t + badgeH, color);
    drawNumber(
      img,
      pos.l + BADGE_PAD_X,
      pos.t + BADGE_PAD_Y,
      el.annotationId,
      digitStyle,
      BADGE_GAP,
      WHITE,
    );
  }
}

/**
 * Decode `inputPng`, overlay numbered colored boxes for each element, return
 * the encoded PNG bytes + element count drawn. Throws {@link AnnotateError}
 * with a typed code on header / decode failure; caller (capture handler)
 * catches and maps to the soft-degrade `annotation.error` field.
 */
export function annotatePng(
  inputPng: Buffer,
  elements: ReadonlyArray<AnnotateInput>,
): AnnotateResult {
  const img = decodePng(inputPng);
  paint(img, elements);
  return { png: encodePng(img), elementCount: elements.length };
}

export { AnnotateError };
