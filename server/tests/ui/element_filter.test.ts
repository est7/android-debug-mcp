import { describe, expect, it } from "vitest";
import {
  type ElementFilter,
  ElementFilterSchema,
  applyElementFilter,
  elementLimitSchema,
} from "../../src/ui/element_filter.ts";
import type { Element } from "../../src/ui/list_elements.ts";

/**
 * v2-F.3 Phase 1 — element_filter unit coverage.
 *
 * Pure projection; no I/O. We construct minimal Element fixtures and assert
 * predicate behavior for each filter dimension + AND composition.
 *
 * Per the design lock (`docs/v2/element-interaction.md` § Amendments §
 * v2-F.3), substring filters are case-insensitive, viewport intersect uses
 * half-open `[left,right) × [top,bottom)` matching `hit_test.ts:133-135`,
 * and `inViewport:true` with `viewport === null` is a no-op (caller emits
 * the `viewport_unknown` warning, not us).
 */

function el(overrides: Partial<Element> = {}): Element {
  return {
    resourceId: null,
    class: "android.widget.View",
    package: "com.example",
    text: null,
    contentDesc: null,
    hint: null,
    bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    center: { x: 50, y: 50 },
    clickable: false,
    focusable: false,
    checkable: false,
    windowIndex: 0,
    ...overrides,
  };
}

const VIEWPORT = { w: 1080, h: 2400 };

describe("ElementFilterSchema — zod validation", () => {
  it("accepts an empty filter object (all fields optional)", () => {
    expect(ElementFilterSchema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown keys (.strict)", () => {
    expect(ElementFilterSchema.safeParse({ junk: 1 }).success).toBe(false);
  });

  it("accepts the five locked fields", () => {
    const ok = ElementFilterSchema.safeParse({
      clickableOnly: true,
      classContains: "Button",
      textContains: "login",
      contentDescContains: "search",
      inViewport: true,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty substring (.min(1))", () => {
    expect(ElementFilterSchema.safeParse({ textContains: "" }).success).toBe(false);
  });
});

describe("elementLimitSchema — default behavior (Round 2 zod chain fix)", () => {
  it("parse(undefined) → 100 (NOT undefined; this is the round 2 regression)", () => {
    expect(elementLimitSchema.parse(undefined)).toBe(100);
  });

  it("accepts caller-supplied 1 (min boundary)", () => {
    expect(elementLimitSchema.parse(1)).toBe(1);
  });

  it("accepts caller-supplied 500 (max boundary)", () => {
    expect(elementLimitSchema.parse(500)).toBe(500);
  });

  it("rejects 0", () => {
    expect(elementLimitSchema.safeParse(0).success).toBe(false);
  });

  it("rejects 501", () => {
    expect(elementLimitSchema.safeParse(501).success).toBe(false);
  });

  it("rejects negative", () => {
    expect(elementLimitSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(elementLimitSchema.safeParse(1.5).success).toBe(false);
  });
});

describe("applyElementFilter — no filter is identity", () => {
  it("returns a fresh array containing every element when filter is undefined", () => {
    const elements = [el({ resourceId: "a" }), el({ resourceId: "b" })];
    const out = applyElementFilter(elements, undefined, VIEWPORT);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(elements); // fresh array
    expect(out[0]?.resourceId).toBe("a");
    expect(out[1]?.resourceId).toBe("b");
  });
});

describe("applyElementFilter — single-field filters", () => {
  it("clickableOnly keeps clickable elements", () => {
    const elements = [el({ clickable: true }), el({ clickable: false })];
    expect(applyElementFilter(elements, { clickableOnly: true }, VIEWPORT)).toHaveLength(1);
  });

  it("classContains is case-insensitive substring on Element.class", () => {
    const elements = [
      el({ class: "android.widget.Button" }),
      el({ class: "android.widget.TextView" }),
    ];
    expect(applyElementFilter(elements, { classContains: "button" }, VIEWPORT)).toHaveLength(1);
    expect(applyElementFilter(elements, { classContains: "BUTTON" }, VIEWPORT)).toHaveLength(1);
  });

  it("textContains skips elements with null text", () => {
    const elements = [el({ text: "Login" }), el({ text: null }), el({ text: "loginvariant" })];
    expect(applyElementFilter(elements, { textContains: "login" }, VIEWPORT)).toHaveLength(2);
  });

  it("contentDescContains matches icon-only elements (text empty, contentDesc set)", () => {
    // Direct cite from the design lock: icon-only Search button with text=""
    // and contentDesc="Search" — must be reachable via contentDescContains.
    const elements = [
      el({ text: "", contentDesc: "Search" }),
      el({ text: "Search results", contentDesc: null }),
      el({ text: null, contentDesc: null }),
    ];
    expect(applyElementFilter(elements, { contentDescContains: "search" }, VIEWPORT)).toHaveLength(
      1,
    );
    // Confirm textContains alone CANNOT reach the icon-only element —
    // contentDesc must be its own field.
    const textOnly = applyElementFilter(elements, { textContains: "search" }, VIEWPORT);
    expect(textOnly).toHaveLength(1);
    expect(textOnly[0]?.text).toBe("Search results");
  });
});

describe("applyElementFilter — AND composition", () => {
  it("clickableOnly + textContains both must satisfy", () => {
    const elements = [
      el({ clickable: true, text: "Login" }),
      el({ clickable: false, text: "Login" }),
      el({ clickable: true, text: "Cancel" }),
    ];
    const out = applyElementFilter(
      elements,
      { clickableOnly: true, textContains: "login" },
      VIEWPORT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("Login");
  });
});

describe("applyElementFilter — inViewport intersect (half-open)", () => {
  // viewport 1080x2400; element bounds describe potential edge cases.

  it("element fully inside the viewport → keep", () => {
    const elements = [el({ bounds: { left: 10, top: 10, right: 200, bottom: 200 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(1);
  });

  it("element fully outside the viewport → drop", () => {
    const elements = [el({ bounds: { left: 2000, top: 3000, right: 2100, bottom: 3100 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(0);
  });

  it("element partially overlaps right edge → keep", () => {
    const elements = [el({ bounds: { left: 1000, top: 100, right: 1200, bottom: 200 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(1);
  });

  it("element touches right edge with zero overlap (bounds.left === w) → drop (half-open)", () => {
    const elements = [el({ bounds: { left: 1080, top: 100, right: 1200, bottom: 200 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(0);
  });

  it("element touches bottom edge with zero overlap (bounds.top === h) → drop", () => {
    const elements = [el({ bounds: { left: 100, top: 2400, right: 200, bottom: 2500 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(0);
  });

  it("element touches left edge with zero overlap (bounds.right === 0) → drop", () => {
    const elements = [el({ bounds: { left: -200, top: 100, right: 0, bottom: 200 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(0);
  });

  it("element touches top edge with zero overlap (bounds.bottom === 0) → drop", () => {
    const elements = [el({ bounds: { left: 100, top: -200, right: 200, bottom: 0 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(0);
  });

  it("element bounds.right === 1 (one pixel inside on left edge) → keep", () => {
    const elements = [el({ bounds: { left: -200, top: 100, right: 1, bottom: 200 } })];
    expect(applyElementFilter(elements, { inViewport: true }, VIEWPORT)).toHaveLength(1);
  });

  it("inViewport:true + viewport === null → no-op (treat as if filter absent)", () => {
    const elements = [
      el({ bounds: { left: 2000, top: 3000, right: 2100, bottom: 3100 } }),
      el({ bounds: { left: 10, top: 10, right: 200, bottom: 200 } }),
    ];
    expect(applyElementFilter(elements, { inViewport: true }, null)).toHaveLength(2);
  });

  it("inViewport:false → ignored (no positive opt-in)", () => {
    const elements = [
      el({ bounds: { left: 2000, top: 3000, right: 2100, bottom: 3100 } }),
      el({ bounds: { left: 10, top: 10, right: 200, bottom: 200 } }),
    ];
    expect(applyElementFilter(elements, { inViewport: false }, VIEWPORT)).toHaveLength(2);
  });
});

describe("applyElementFilter — truncated false-positive regression (lock § F3-Q8)", () => {
  // The original Round 1 draft used `unfilteredCount` for the truncation
  // signal — that produced a false `truncated:true` when raw 80 → filter 1
  // → limit 1. applyElementFilter doesn't compute `truncated` itself
  // (handler does, with the filteredCount vs returned length check) but
  // these tests anchor the math by inspecting the array sizes the helper
  // returns.
  it("80 raw → filter narrows to 1 → handler limit=1: filtered.length === 1, no truncation", () => {
    const elements: Element[] = [];
    for (let i = 0; i < 79; i++) elements.push(el({ text: "noise" }));
    elements.push(el({ text: "Login button" }));
    const filtered = applyElementFilter(elements, { textContains: "login" } as ElementFilter, null);
    expect(filtered.length).toBe(1);
    // Caller does `filtered.length > limit` to decide truncation; 1 > 1 === false.
    expect(filtered.length > 1).toBe(false);
  });

  it("80 raw → filter keeps all 80 → handler limit=10: filtered.length > limit, truncation applies", () => {
    const elements: Element[] = [];
    for (let i = 0; i < 80; i++) elements.push(el({ clickable: true }));
    const filtered = applyElementFilter(elements, { clickableOnly: true }, null);
    expect(filtered.length).toBe(80);
    expect(filtered.length > 10).toBe(true);
  });
});
