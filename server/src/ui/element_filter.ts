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
 * `limit` zod fragment shared across the two tools' input schemas.
 *
 * Chain order matters: `z.number().default(100)` evaluates as
 * "number, with 100 as the substituted value when input is undefined."
 * Wrapping that in `.optional()` (i.e. `.default(100).optional()`) re-adds
 * an `undefined` arm AFTER the default, which means `parse(undefined)`
 * returns `undefined` — defeating the default. The runtime-correct shape
 * is bare `.default(100)`; the caller can still omit the field because
 * `z.input<...>` treats `.default(...)` as optional input but
 * `z.output<...>` types it as required-with-fallback.
 */
export const elementLimitSchema = z.number().int().min(1).max(500).default(100);

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
