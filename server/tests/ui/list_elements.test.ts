import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUiHierarchy } from "../../src/ui/hierarchy.ts";
import { collectElements } from "../../src/ui/list_elements.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/ui/${name}`, import.meta.url)), "utf8");
}

describe("collectElements — real device dumps", () => {
  it("happy path on Poppo homepage: single window, parser fields land on elements", () => {
    const roots = parseUiHierarchy(fixture("poppo-homepage.xml"));
    const elements = collectElements(roots);
    expect(roots.length).toBe(1);
    expect(elements.length).toBeGreaterThan(20);
    expect(elements.every((e) => e.windowIndex === 0)).toBe(true);

    // text / contentDesc / clickable should each appear on at least one element
    // — proof that Phase 0 parser additive fields are propagating through.
    expect(elements.some((e) => e.text !== null && e.text.length > 0)).toBe(true);
    expect(elements.some((e) => e.contentDesc !== null && e.contentDesc.length > 0)).toBe(true);
    expect(elements.some((e) => e.clickable)).toBe(true);
    // selected=true is the tab-icon state captured in the fixture
    expect(elements.some((e) => e.selected === true)).toBe(true);
  });

  it("non-fullscreen top root: poppo-overlay reports windowCount=1 with all bounds inside the dialog rect", () => {
    const roots = parseUiHierarchy(fixture("poppo-overlay.xml"));
    const elements = collectElements(roots);
    expect(roots.length).toBe(1);
    expect(elements.every((e) => e.windowIndex === 0)).toBe(true);
    // The overlay fixture was harvested with the share dialog open at
    // [0,1399][1080,2320] — every emitted element should sit inside that rect.
    for (const e of elements) {
      expect(e.bounds.left).toBeGreaterThanOrEqual(0);
      expect(e.bounds.top).toBeGreaterThanOrEqual(1399);
      expect(e.bounds.right).toBeLessThanOrEqual(1080);
      expect(e.bounds.bottom).toBeLessThanOrEqual(2320);
    }
  });
});

describe("collectElements — synthetic XML for fields not covered by real fixtures", () => {
  it("propagates `hint` from a parsed EditText through to the Element", () => {
    const xml =
      '<hierarchy><node class="android.widget.EditText" package="p" bounds="[0,0][100,40]" hint="Search" focusable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(1);
    expect(elements[0]?.hint).toBe("Search");
  });

  it("emits `checked: true` only when the node is checkable AND checked", () => {
    const xml =
      '<hierarchy><node class="android.widget.CheckBox" package="p" bounds="[0,0][100,100]" checkable="true" checked="true" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(1);
    expect(elements[0]?.checked).toBe(true);
    expect(elements[0]?.checkable).toBe(true);
  });

  it("drops `checked` when the node is `checked=true` but NOT `checkable=true` (uiautomator noise)", () => {
    // Some uiautomator dumps emit `checked="true"` on non-checkable views;
    // the design lock pins `checked?: true` to (checkable AND checked).
    const xml =
      '<hierarchy><node class="android.widget.TextView" package="p" resource-id="p:id/t" bounds="[0,0][100,40]" checked="true" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(1);
    expect(elements[0]?.checkable).toBe(false);
    expect(elements[0] as unknown as Record<string, unknown>).not.toHaveProperty("checked");
  });

  it("omits state booleans entirely when false (no `focused:false` leak)", () => {
    const xml =
      '<hierarchy><node class="android.widget.Button" package="p" resource-id="p:id/ok" bounds="[0,0][100,40]" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(1);
    const e = elements[0] as unknown as Record<string, unknown>;
    expect(e).not.toHaveProperty("focused");
    expect(e).not.toHaveProperty("selected");
    expect(e).not.toHaveProperty("checked");
  });
});

describe("collectElements — z-order and windowIndex", () => {
  it("emits windowIndex=0 for the document-order LAST root (z-order topmost)", () => {
    // Two roots; the last in document order is z-order topmost per hit_test contract.
    const xml =
      "<hierarchy>" +
      '<node class="L.Bottom" package="p" resource-id="p:id/bottom_root" bounds="[0,0][100,100]" />' +
      '<node class="L.Top" package="p" resource-id="p:id/top_root" bounds="[0,0][100,100]" />' +
      "</hierarchy>";
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(2);
    // Emit order: topmost first.
    expect(elements[0]?.resourceId).toBe("p:id/top_root");
    expect(elements[0]?.windowIndex).toBe(0);
    expect(elements[1]?.resourceId).toBe("p:id/bottom_root");
    expect(elements[1]?.windowIndex).toBe(1);
  });

  it("walks each window's tree in DFS post-order (leaves before their parents)", () => {
    const xml =
      '<hierarchy><node class="Parent" package="p" resource-id="p:id/parent" bounds="[0,0][100,100]" clickable="true">' +
      '<node class="Leaf" package="p" resource-id="p:id/leaf" bounds="[10,10][50,50]" clickable="true" />' +
      "</node></hierarchy>";
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements.map((e) => e.resourceId)).toEqual(["p:id/leaf", "p:id/parent"]);
  });
});

describe("collectElements — filter rules", () => {
  it("drops nodes with no text / id / clickable / checkable / contentDesc / hint", () => {
    const xml =
      '<hierarchy><node class="android.widget.LinearLayout" package="p" bounds="[0,0][100,100]" /></hierarchy>';
    expect(collectElements(parseUiHierarchy(xml))).toEqual([]);
  });

  it("drops degenerate-bounds nodes (zero area) even when otherwise useful", () => {
    const xml =
      '<hierarchy><node class="android.widget.Button" package="p" resource-id="p:id/btn" bounds="[10,10][10,10]" clickable="true" /></hierarchy>';
    expect(collectElements(parseUiHierarchy(xml))).toEqual([]);
  });

  it("drops missing-bounds nodes too", () => {
    const xml = '<hierarchy><node class="X" package="p" resource-id="p:id/x" /></hierarchy>';
    expect(collectElements(parseUiHierarchy(xml))).toEqual([]);
  });

  it("keeps a clickable scrim that has no text / id (matches mobile-mcp deviation)", () => {
    const xml =
      '<hierarchy><node class="android.widget.FrameLayout" package="p" bounds="[0,0][100,100]" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements).toHaveLength(1);
    expect(elements[0]?.clickable).toBe(true);
  });
});

describe("collectElements — center coordinate", () => {
  it("uses Math.floor on odd bounds so no element emits a `.5` center", () => {
    const xml =
      '<hierarchy><node class="X" package="p" resource-id="p:id/x" bounds="[10,10][101,101]" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements[0]?.center).toEqual({ x: 55, y: 55 });
  });

  it("computes the center of an even-bounds node exactly", () => {
    const xml =
      '<hierarchy><node class="X" package="p" resource-id="p:id/x" bounds="[0,0][100,40]" clickable="true" /></hierarchy>';
    const elements = collectElements(parseUiHierarchy(xml));
    expect(elements[0]?.center).toEqual({ x: 50, y: 20 });
  });
});

describe("collectElements — empty / no-element shapes", () => {
  it("returns [] for an empty <hierarchy/>", () => {
    expect(collectElements(parseUiHierarchy("<hierarchy></hierarchy>"))).toEqual([]);
  });

  it("returns [] when every node is filtered out", () => {
    const xml =
      '<hierarchy><node class="android.widget.FrameLayout" package="p" bounds="[0,0][1080,2400]">' +
      '<node class="android.widget.LinearLayout" package="p" bounds="[0,0][1080,2400]" />' +
      "</node></hierarchy>";
    expect(collectElements(parseUiHierarchy(xml))).toEqual([]);
  });
});
