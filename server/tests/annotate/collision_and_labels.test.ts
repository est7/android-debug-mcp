import { describe, expect, it } from "vitest";
import {
  MAX_LABEL_CHARS,
  clampBadgeRect,
  classShortLabel,
  placeBadgeWithCollision,
} from "../../src/annotate/annotate.ts";

/**
 * v2-F.2 Phase 1 — unit coverage for the placement / clamp / label helpers
 * added by this sprint. End-to-end annotate paint behavior is already
 * covered by `annotate.test.ts` (v0.5.0/v0.5.2) and `capture_annotate.test.ts`
 * (v2-F.3); these tests pin the pure algorithm decisions in design lock
 * § F2-Q2 (collision) and § F2-Q3 (label).
 */

const VIEWPORT_FHD = { w: 1080, h: 2400 };

describe("classShortLabel — design lock § F2-Q3", () => {
  it("empty class → empty label", () => {
    expect(classShortLabel("")).toBe("");
  });

  it("simple class name passes through unchanged when ≤ 8 chars", () => {
    expect(classShortLabel("Button")).toBe("Button");
  });

  it("FQCN keeps only the last segment", () => {
    expect(classShortLabel("android.widget.Button")).toBe("Button");
  });

  it("longer FQCN keeps only the last segment then truncates to 8 chars", () => {
    expect(classShortLabel("android.widget.ImageButton")).toBe("ImageBut");
  });

  it("RecyclerView from androidx → 'Recycler'", () => {
    expect(classShortLabel("androidx.recyclerview.widget.RecyclerView")).toBe("Recycler");
  });

  it("MAX_LABEL_CHARS is the source-of-truth slice length", () => {
    expect(MAX_LABEL_CHARS).toBe(8);
  });
});

describe("clampBadgeRect — half-open viewport intersect", () => {
  it("fully inside → unchanged rect", () => {
    expect(clampBadgeRect(100, 200, 50, 30, VIEWPORT_FHD)).toEqual({
      l: 100,
      t: 200,
      r: 150,
      b: 230,
    });
  });

  it("right edge overflow → clamp r to viewport.w; left untouched", () => {
    expect(clampBadgeRect(1050, 100, 60, 30, VIEWPORT_FHD)).toEqual({
      l: 1050,
      t: 100,
      r: 1080,
      b: 130,
    });
  });

  it("entirely past right edge → collapses to empty rect", () => {
    const r = clampBadgeRect(1200, 100, 60, 30, VIEWPORT_FHD);
    expect(r.l).toBe(1080);
    expect(r.r).toBe(1080);
    expect(r.l).toBe(r.r); // empty width
  });

  it("negative top → clamp t to 0", () => {
    expect(clampBadgeRect(50, -20, 40, 30, VIEWPORT_FHD)).toEqual({
      l: 50,
      t: 0,
      r: 90,
      b: 10,
    });
  });

  it("entirely above viewport → empty rect (b <= t)", () => {
    const r = clampBadgeRect(50, -100, 40, 30, VIEWPORT_FHD);
    expect(r.b).toBe(0);
    expect(r.t).toBe(0);
    expect(r.b).toBe(r.t); // empty height
  });
});

describe("placeBadgeWithCollision — design lock § F2-Q2 5-candidate order", () => {
  // Bbox 600×400 with badge 100×40 always fits all 4 inside corners.
  const BBOX = { l: 100, t: 100, r: 700, b: 500 };
  const BADGE = { w: 100, h: 40 };

  it("no prior badges → inside-TL wins", () => {
    const placed = placeBadgeWithCollision(
      BBOX.l,
      BBOX.t,
      BBOX.r,
      BBOX.b,
      BADGE.w,
      BADGE.h,
      [],
      VIEWPORT_FHD,
    );
    // inside-TL at (l + 6, t + 6) → (106, 106) — matches BADGE_INSET=6 in source.
    expect(placed.l).toBe(106);
    expect(placed.t).toBe(106);
  });

  it("inside-TL blocked → falls to inside-TR", () => {
    const tlOccupied = { l: 100, t: 100, r: 250, b: 200 };
    const placed = placeBadgeWithCollision(
      BBOX.l,
      BBOX.t,
      BBOX.r,
      BBOX.b,
      BADGE.w,
      BADGE.h,
      [tlOccupied],
      VIEWPORT_FHD,
    );
    // inside-TR at (r - 6 - badgeW, t + 6) = (594, 106)
    expect(placed.l).toBe(594);
    expect(placed.t).toBe(106);
  });

  it("inside-TL + inside-TR blocked → falls to inside-BL", () => {
    const occupied = [
      { l: 100, t: 100, r: 250, b: 200 }, // blocks TL
      { l: 580, t: 100, r: 700, b: 200 }, // blocks TR
    ];
    const placed = placeBadgeWithCollision(
      BBOX.l,
      BBOX.t,
      BBOX.r,
      BBOX.b,
      BADGE.w,
      BADGE.h,
      occupied,
      VIEWPORT_FHD,
    );
    // inside-BL at (l + 6, b - 6 - badgeH) = (106, 454)
    expect(placed.l).toBe(106);
    expect(placed.t).toBe(454);
  });

  it("all 4 inside corners blocked → falls to outside-TL", () => {
    const occupied = [
      { l: 100, t: 100, r: 250, b: 200 }, // TL
      { l: 580, t: 100, r: 700, b: 200 }, // TR
      { l: 100, t: 440, r: 250, b: 500 }, // BL
      { l: 580, t: 440, r: 700, b: 500 }, // BR
    ];
    const placed = placeBadgeWithCollision(
      BBOX.l,
      BBOX.t,
      BBOX.r,
      BBOX.b,
      BADGE.w,
      BADGE.h,
      occupied,
      VIEWPORT_FHD,
    );
    // outside-TL at (l, t - badgeH) = (100, 60)
    expect(placed.l).toBe(100);
    expect(placed.t).toBe(60);
  });

  it("inside-eligibility fails for tiny bbox → outside-TL wins (badge > 0.5 × bbox)", () => {
    // 40 × 20 bbox is way too small for a 100 × 40 badge inside.
    const placed = placeBadgeWithCollision(0, 100, 40, 120, BADGE.w, BADGE.h, [], VIEWPORT_FHD);
    // outside-TL at (l=0, t=100-40=60)
    expect(placed.l).toBe(0);
    expect(placed.t).toBe(60);
  });

  it("all 5 candidates fail → degrades to outside-TL clamped (last-resort fallback)", () => {
    // Tiny bbox + outside-TL also blocked. Outside-TL would land at (l=0, t=60)
    // — block it with a placedRect that fully covers that position.
    const occupied = [{ l: 0, t: 60, r: 100, b: 100 }];
    const placed = placeBadgeWithCollision(
      0,
      100,
      40,
      120,
      BADGE.w,
      BADGE.h,
      occupied,
      VIEWPORT_FHD,
    );
    // Degraded: still returns outside-TL clamped rect even though it overlaps.
    expect(placed.l).toBe(0);
    expect(placed.t).toBe(60);
  });

  it("partial-clip degrade: bbox near right edge → outside-TL clipped to viewport.w", () => {
    // Bbox close to right edge so inside-TR/BR would push the badge off-screen
    // entirely. inside-TL fits but only as a clipped rect.
    const placed = placeBadgeWithCollision(
      1000,
      100,
      1100, // bbox.r = 1100 > viewport.w = 1080
      300,
      BADGE.w, // badge 100 wide
      BADGE.h,
      [],
      VIEWPORT_FHD,
    );
    // bbox.w = 100 ≤ 2*(badge.w+INSET) so insideEligible = false;
    // outside-TL at (1000, 60) clamped → r = min(1080, 1000+100) = 1080
    expect(placed.r).toBe(1080);
    expect(placed.l).toBe(1000);
  });
});
