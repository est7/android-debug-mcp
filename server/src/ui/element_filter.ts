/**
 * v2-F.3 — server-side filter for `list_elements` and
 * `capture({annotateElements:true})`. Shared zod schema + pure filter
 * function so the two tool entrypoints cannot drift.
 *
 * Design lock: `docs/v2/element-interaction.md` § Amendments §
 * "2026-05-28 · v2-F.3 list_elements / capture.annotateElements filter".
 *
 * Contract surface (recap; see lock for full Q-decisions):
 *
 *   - `ElementFilterSchema` — strict zod object with five optional fields
 *     (`clickableOnly` / `classContains` / `textContains` /
 *     `contentDescContains` / `inViewport`). Composed as AND. Substring
 *     fields are case-insensitive (Element.text / contentDesc / class).
 *   - `elementLimitSchema` — `z.number().int().min(1).max(500).default(100)`.
 *     **NOT** `.optional()`: `.default(100).optional()` resolves omitted
 *     input to `undefined` instead of 100 (verified locally). Matches
 *     v2-G evidence search's existing `limit` shape.
 *   - `applyElementFilter(elements, filter, viewport)` — pure projection:
 *     returns the subset that satisfies every present filter clause. If
 *     `inViewport:true` but `viewport === null` (probe failed), `inViewport`
 *     is treated as a no-op (caller surfaces `viewport_unknown` warning
 *     separately, per F3-Q4).
 *   - Viewport intersect uses HALF-OPEN coordinates `[left, right) × [top,
 *     bottom)`, aligning with `server/src/ui/hit_test.ts:133-135`. An
 *     element whose `bounds.left === viewport.w` (touching the right edge
 *     with zero pixels inside) is OUT.
 */

import { z } from "zod";
import type { Viewport } from "../adb/viewport.ts";
import type { Element } from "./list_elements.ts";

export type { Viewport };

export const ElementFilterSchema = z
  .object({
    clickableOnly: z.boolean().optional(),
    classContains: z.string().min(1).max(255).optional(),
    textContains: z.string().min(1).max(255).optional(),
    contentDescContains: z.string().min(1).max(255).optional(),
    inViewport: z.boolean().optional(),
  })
  .strict();

export type ElementFilter = z.output<typeof ElementFilterSchema>;

/**
 * Numeric bounds shared by the two `limit` variants below. Kept private —
 * callers compose with the bounds via the two exported wrappers; mixing
 * `.default(...)` with `.optional()` would silently break the default.
 */
const elementLimitBounds = z.number().int().min(1).max(500);

/**
 * `limit` zod fragment for `list_elements`. Bare `.default(100)` — the
 * caller can omit, in which case post-parse `input.limit` is the number
 * `100`. v2-F.3 Round 2 codex STOP #1 fix: do NOT chain `.optional()`
 * after `.default(...)`; that resolves omitted to `undefined`, defeating
 * the default. Matches the v2-G evidence search `limit` shape.
 */
export const elementLimitSchema = elementLimitBounds.default(100);

/**
 * `limit` zod fragment for `capture({annotateElements:true})`. Bare
 * `.optional()` — NO default at the schema layer. The handler applies the
 * 100 default only when `annotateElements:true`, so the F3-Q7 strict
 * reject can distinguish "caller passed limit:100 without annotate"
 * (always reject, even though the value happens to equal the default)
 * from "caller omitted limit" (no rejection).
 *
 * Round 3 amendment (post-cut audit blocker #3): the v0.5.2 cut used
 * `elementLimitSchema` here too, but that meant `input.limit !== 100`
 * was the only signal for "explicit limit," so `{limit:100}` without
 * annotate slipped past F3-Q7's reject. This separate optional variant
 * preserves caller intent at parse time.
 */
export const captureElementLimitSchema = elementLimitBounds.optional();

/**
 * Apply the filter to `elements`. AND composition over present fields;
 * missing fields are no-ops. Pure function, O(elements.length) per
 * predicate. Returns a fresh array; does not mutate `elements`.
 */
export function applyElementFilter(
  elements: readonly Element[],
  filter: ElementFilter | undefined,
  viewport: Viewport | null,
): Element[] {
  if (filter === undefined) return [...elements];

  // Pre-lowercase the substring needles once so the per-element check is a
  // single `indexOf`. Empty string is impossible (zod `.min(1)`).
  const classNeedle = filter.classContains?.toLowerCase();
  const textNeedle = filter.textContains?.toLowerCase();
  const contentDescNeedle = filter.contentDescContains?.toLowerCase();
  const viewportActive = filter.inViewport === true && viewport !== null;

  return elements.filter((el) => {
    if (filter.clickableOnly === true && !el.clickable) return false;
    if (classNeedle !== undefined && !el.class.toLowerCase().includes(classNeedle)) return false;
    if (textNeedle !== undefined) {
      // text is nullable. Missing text never satisfies a positive substring.
      if (el.text === null || !el.text.toLowerCase().includes(textNeedle)) return false;
    }
    if (contentDescNeedle !== undefined) {
      if (el.contentDesc === null || !el.contentDesc.toLowerCase().includes(contentDescNeedle))
        return false;
    }
    if (viewportActive && !intersectsViewport(el.bounds, viewport as Viewport)) return false;
    return true;
  });
}

/**
 * Half-open intersect test: an element keeps if any pixel of its
 * `[left, right) × [top, bottom)` bounds is inside
 * `[0, viewport.w) × [0, viewport.h)`.
 *
 * The four boundary rejections:
 *   - `bounds.right <= 0`  — element ends at or before the left edge.
 *   - `bounds.left >= w`   — element starts at or after the right edge.
 *   - `bounds.bottom <= 0` — element ends at or before the top edge.
 *   - `bounds.top >= h`    — element starts at or after the bottom edge.
 *
 * Elements with `bounds.right === 0` or `bounds.left === w` have ZERO
 * overlap with the viewport even though their edge "touches" — half-open
 * convention rejects them. Aligns with `hit_test.ts:133-135`.
 */
function intersectsViewport(bounds: Element["bounds"], viewport: Viewport): boolean {
  return !(
    bounds.right <= 0 ||
    bounds.left >= viewport.w ||
    bounds.bottom <= 0 ||
    bounds.top >= viewport.h
  );
}
