import { DEFAULT_DIGIT_STYLE, DEFAULT_LABEL_SCALE, measureNumber, measureText } from "./glyphs.ts";
import {
  AnnotateError,
  type ImageBuffer,
  type RGBA,
  decodePng,
  drawNumber,
  drawText,
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
// v2-F.2 — gap between label "Button" and `:` separator on the badge.
const LABEL_DIGIT_GAP = 4;
const LABEL_SEPARATOR = ":";
/** Max label chars after truncation (design lock § F2-Q3). */
export const MAX_LABEL_CHARS = 8;

/**
 * What annotate needs per element. Subset of v2-F.0 Element: `bounds.{l,t,r,b}`
 * + optional `label` (v2-F.2; e.g. "Button" / "EditText" — already
 * shortened by the caller). The caller (`capture` handler) is responsible
 * for mapping each Element → this minimal shape so the renderer stays
 * decoupled from the public Element schema.
 */
export interface AnnotateInput {
  readonly annotationId: number;
  readonly bounds: {
    readonly l: number;
    readonly t: number;
    readonly r: number;
    readonly b: number;
  };
  /** v2-F.2 — optional label string drawn before `:<digits>` on the badge.
   *  When undefined, the badge contains digits only (v2-F.1 byte-equivalent). */
  readonly label?: string;
}

interface BadgeRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/**
 * v2-F.2 — derive a short ASCII label from an Android class FQCN. Per design
 * lock § F2-Q3: `class.split('.').pop().slice(0, MAX_LABEL_CHARS)`.
 *
 *   "android.widget.Button"                       → "Button"
 *   "android.widget.EditText"                     → "EditText"
 *   "android.widget.ImageButton"                  → "ImageBut"
 *   "androidx.recyclerview.widget.RecyclerView"   → "Recycler"
 *
 * Returns `""` for an empty input; caller can decide whether to skip label
 * draw entirely (renderer treats empty label as "no label").
 */
export function classShortLabel(className: string): string {
  if (className.length === 0) return "";
  const last = className.split(".").pop() ?? "";
  return last.slice(0, MAX_LABEL_CHARS);
}

export interface AnnotateResult {
  readonly png: Buffer;
  readonly elementCount: number;
}

function colorAt(i: number): RGBA {
  return PALETTE[i % PALETTE.length] ?? ([0xff, 0, 0, 0xff] as const);
}

/**
 * v2-F.2 — half-open viewport-clipped rect.
 *
 * Both collision detection and paint must operate on the same clamped rect;
 * otherwise the `placedBadgeRects` accumulator stores a different shape than
 * what's actually painted, and downstream overlap checks misjudge (design
 * lock § F2-Q2 Round 1 amendment).
 *
 * Half-open `[l, r) × [t, b)` matches `element_filter.ts` viewport intersect
 * and `hit_test.ts` hit semantics — a candidate fully past `viewport.w` on
 * the left edge collapses to an empty rect, not a phantom one.
 */
export function clampBadgeRect(
  candidateL: number,
  candidateT: number,
  badgeW: number,
  badgeH: number,
  viewport: { readonly w: number; readonly h: number },
): BadgeRect {
  const rawR = candidateL + badgeW;
  const rawB = candidateT + badgeH;
  return {
    l: Math.max(0, Math.min(viewport.w, candidateL)),
    t: Math.max(0, Math.min(viewport.h, candidateT)),
    r: Math.max(0, Math.min(viewport.w, rawR)),
    b: Math.max(0, Math.min(viewport.h, rawB)),
  };
}

function isEmpty(rect: BadgeRect): boolean {
  return rect.r <= rect.l || rect.b <= rect.t;
}

function overlaps(a: BadgeRect, b: BadgeRect): boolean {
  // Half-open: edge-touching is NOT overlap (b.l === a.r is fine).
  return !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
}

interface PlaceCandidate {
  readonly l: number;
  readonly t: number;
  /** True iff the candidate would fit fully inside the bbox (used to gate the
   *  inside corner placements). Outside candidates always pass this. */
  readonly insideEligible: boolean;
}

/**
 * v2-F.2 — pick the first non-overlapping placement for a badge of
 * (`badgeW`, `badgeH`) given a bbox + already-placed badges + viewport.
 *
 * Candidate order (design lock § F2-Q2): inside-TL → inside-TR → inside-BL →
 * inside-BR → outside-TL (clamped). First non-overlapping AND non-empty
 * (after viewport clamp) wins. If all 5 fail, fall back to candidate 4
 * (outside-TL) — degrade-clipped is acceptable, push the clamped rect.
 *
 * The "inside" candidates additionally require `badge fits in bbox/2`
 * (mirrors v0.5.0 `placeBadge` heuristic so a tiny element doesn't get a
 * giant inside badge crowding it out).
 */
export function placeBadgeWithCollision(
  bboxL: number,
  bboxT: number,
  bboxR: number,
  bboxB: number,
  badgeW: number,
  badgeH: number,
  placed: readonly BadgeRect[],
  viewport: { readonly w: number; readonly h: number },
): BadgeRect {
  const bboxW = bboxR - bboxL;
  const bboxH = bboxB - bboxT;
  const fitsInside =
    badgeW + BADGE_INSET * 2 <= bboxW * 0.5 && badgeH + BADGE_INSET * 2 <= bboxH * 0.5;
  const candidates: readonly PlaceCandidate[] = [
    { l: bboxL + BADGE_INSET, t: bboxT + BADGE_INSET, insideEligible: fitsInside },
    {
      l: bboxR - BADGE_INSET - badgeW,
      t: bboxT + BADGE_INSET,
      insideEligible: fitsInside,
    },
    {
      l: bboxL + BADGE_INSET,
      t: bboxB - BADGE_INSET - badgeH,
      insideEligible: fitsInside,
    },
    {
      l: bboxR - BADGE_INSET - badgeW,
      t: bboxB - BADGE_INSET - badgeH,
      insideEligible: fitsInside,
    },
    { l: bboxL, t: bboxT - badgeH, insideEligible: true },
  ];

  for (let i = 0; i < 5; i++) {
    const cand = candidates[i] as PlaceCandidate;
    // Inside-corner candidates require the bbox to be large enough; outside
    // (candidate 4) bypasses this check.
    if (i < 4 && !cand.insideEligible) continue;
    const rect = clampBadgeRect(cand.l, cand.t, badgeW, badgeH, viewport);
    if (isEmpty(rect)) continue;
    let collided = false;
    for (const other of placed) {
      if (overlaps(rect, other)) {
        collided = true;
        break;
      }
    }
    if (!collided) return rect;
  }

  // All 5 candidates failed (inside-eligibility or overlap or empty). Degrade
  // to candidate 4 (outside-TL) clamped — accepted clipped/overlapping per
  // design lock § F2-Q2 "best-effort for oversized badges".
  const fallback = candidates[4] as PlaceCandidate;
  return clampBadgeRect(fallback.l, fallback.t, badgeW, badgeH, viewport);
}

/** Paint boxes + numbered badges in-place, with per-element label + collision
 *  avoidance (v2-F.2). */
function paint(
  img: ImageBuffer,
  elements: ReadonlyArray<AnnotateInput>,
  viewport: { readonly w: number; readonly h: number },
): void {
  const digitStyle = DEFAULT_DIGIT_STYLE;
  const placedBadgeRects: BadgeRect[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el) continue;
    const { l, t, r, b } = el.bounds;
    const color = colorAt(i);
    strokeRect(img, l, t, r, b, color, BBOX_STROKE);

    // Compose badge content. Layout: [label] [":"] [digits]. When label is
    // empty (or AnnotateInput.label omitted), the label and ":" segments
    // collapse to zero width — badge is digit-only, matching v0.5.0.
    const labelText = el.label ?? "";
    const labelMetric =
      labelText.length > 0 ? measureText(labelText, DEFAULT_LABEL_SCALE) : { width: 0, height: 0 };
    const sepMetric =
      labelText.length > 0
        ? measureText(LABEL_SEPARATOR, DEFAULT_LABEL_SCALE)
        : { width: 0, height: 0 };
    const digitMetric = measureNumber(el.annotationId, digitStyle, BADGE_GAP);
    const labelPlusSepWidth =
      labelText.length > 0
        ? labelMetric.width + LABEL_DIGIT_GAP + sepMetric.width + LABEL_DIGIT_GAP
        : 0;
    const contentWidth = labelPlusSepWidth + digitMetric.width;
    const badgeW = contentWidth + BADGE_PAD_X * 2;
    const badgeH = digitMetric.height + BADGE_PAD_Y * 2;

    const rect = placeBadgeWithCollision(l, t, r, b, badgeW, badgeH, placedBadgeRects, viewport);
    placedBadgeRects.push(rect);

    // Paint background + content. fillRect / drawNumber / drawText all clip
    // to image bounds, so an oversized badge degrades gracefully.
    fillRect(img, rect.l, rect.t, rect.r, rect.b, color);
    let cursor = rect.l + BADGE_PAD_X;
    // Vertical center: label baseline (height = digitMetric.height visually).
    const digitY = rect.t + BADGE_PAD_Y;
    if (labelText.length > 0) {
      const labelY = digitY + Math.floor((digitMetric.height - labelMetric.height) / 2);
      drawText(img, cursor, labelY, labelText, DEFAULT_LABEL_SCALE, WHITE);
      cursor += labelMetric.width + LABEL_DIGIT_GAP;
      drawText(img, cursor, labelY, LABEL_SEPARATOR, DEFAULT_LABEL_SCALE, WHITE);
      cursor += sepMetric.width + LABEL_DIGIT_GAP;
    }
    drawNumber(img, cursor, digitY, el.annotationId, digitStyle, BADGE_GAP, WHITE);
  }
}

/**
 * Decode `inputPng`, overlay numbered colored boxes for each element, return
 * the encoded PNG bytes + element count drawn. Throws {@link AnnotateError}
 * with a typed code on header / decode failure; caller (capture handler)
 * catches and maps to the soft-degrade `annotation.error` field.
 *
 * `viewport` defaults to the decoded PNG's own dimensions — collision /
 * paint stay clipped to actual canvas (v2-F.2). Caller can override when
 * the painted canvas is smaller than the logical device viewport (rare).
 */
export function annotatePng(
  inputPng: Buffer,
  elements: ReadonlyArray<AnnotateInput>,
  viewport?: { readonly w: number; readonly h: number },
): AnnotateResult {
  const img = decodePng(inputPng);
  paint(img, elements, viewport ?? { w: img.width, h: img.height });
  return { png: encodePng(img), elementCount: elements.length };
}

export { AnnotateError };
