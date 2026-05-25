import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUiHierarchy } from "../../src/ui/hierarchy.ts";
import { resolveTap } from "../../src/ui/hit_test.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/ui/${name}`, import.meta.url)), "utf8");
}

const wrap = (inner: string): string => `<hierarchy>${inner}</hierarchy>`;

describe("resolveTap — real device dump (Poppo HomepageActivity)", () => {
  const roots = parseUiHierarchy(fixture("poppo-homepage.xml"));

  it("resolves a tap on the back button to that node as its own anchor", () => {
    // backButton bounds [34,99][122,187] — drawn on top of the full-screen
    // face_container behind it; z-order descent must pick it, not the deeper
    // ivAvatarFace.
    const r = resolveTap(roots, 78, 143, "com.baitu.poppo");
    expect(r).not.toBeNull();
    expect(r?.tappedNode.resourceId).toBe("com.baitu.poppo:id/backButton");
    expect(r?.anchorSource).toBe("tapped_node");
    expect(r?.anchorNode).toBe(r?.tappedNode);
    expect(r?.ancestorChain.length).toBeGreaterThan(0);
  });

  it("walks up to an ancestor anchor when the tapped node has no resource-id", () => {
    // (80,1060): inside the first tab's unnamed LinearLayout, off the icon.
    const r = resolveTap(roots, 80, 1060, "com.baitu.poppo");
    expect(r?.tappedNode.resourceId).toBeNull();
    expect(r?.anchorSource).toBe("ancestor");
    expect(r?.anchorNode?.resourceId).toBe("com.baitu.poppo:id/tabLayout");
  });
});

describe("resolveTap — tie-break rules", () => {
  it("a deeper node beats its containing parent", () => {
    const xml = wrap(
      '<node class="P" package="p" resource-id="p:id/parent" bounds="[0,0][100,100]">' +
        '<node class="C" package="p" resource-id="p:id/child" bounds="[10,10][90,90]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 50, 50, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/child");
  });

  it("equal-bounds parent and child resolve to the child", () => {
    const xml = wrap(
      '<node class="P" package="p" resource-id="p:id/parent" bounds="[0,0][100,100]">' +
        '<node class="C" package="p" resource-id="p:id/child" bounds="[0,0][100,100]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 50, 50, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/child");
  });

  it("overlapping same-depth siblings resolve to the later (topmost) one", () => {
    const xml = wrap(
      '<node class="R" package="p" bounds="[0,0][100,100]">' +
        '<node class="A" package="p" resource-id="p:id/under" bounds="[0,0][80,80]" />' +
        '<node class="B" package="p" resource-id="p:id/over" bounds="[20,20][100,100]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 50, 50, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/over");
  });

  it("a later sibling subtree wins over an earlier, deeper one (z-order beats depth)", () => {
    const xml = wrap(
      '<node class="R" package="p" bounds="[0,0][100,100]">' +
        '<node class="E" package="p" bounds="[0,0][100,100]">' +
        '<node class="EM" package="p" bounds="[0,0][100,100]">' +
        '<node class="ED" package="p" resource-id="p:id/early_deep" bounds="[0,0][100,100]" />' +
        "</node></node>" +
        '<node class="L" package="p" resource-id="p:id/late" bounds="[0,0][100,100]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 50, 50, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/late");
  });
});

describe("resolveTap — multi-window overlays", () => {
  const roots = parseUiHierarchy(
    "<hierarchy>" +
      '<node class="Main" package="p" resource-id="p:id/main" bounds="[0,0][100,100]">' +
      '<node class="MainBtn" package="p" resource-id="p:id/main_btn" bounds="[0,0][50,50]" /></node>' +
      '<node class="Dialog" package="p" resource-id="p:id/dialog" bounds="[40,40][100,100]">' +
      '<node class="DialogBtn" package="p" resource-id="p:id/dialog_btn" bounds="[40,40][80,80]" /></node>' +
      "</hierarchy>",
  );

  it("a tap inside the overlay resolves within the topmost window", () => {
    const r = resolveTap(roots, 60, 60, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/dialog_btn");
  });

  it("a tap outside the overlay falls through to the window below", () => {
    const r = resolveTap(roots, 20, 20, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/main_btn");
  });
});

describe("resolveTap — anchor selection", () => {
  it("returns anchorSource none when no node carries an app resource-id", () => {
    const xml = wrap(
      '<node class="R" package="p" bounds="[0,0][100,100]">' +
        '<node class="C" package="p" bounds="[0,0][50,50]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 25, 25, "p");
    expect(r?.anchorNode).toBeNull();
    expect(r?.anchorSource).toBe("none");
  });

  it("never anchors on a framework resource-id, only the session package", () => {
    const xml = wrap(
      '<node class="R" package="com.x" resource-id="com.x:id/root" bounds="[0,0][100,100]">' +
        '<node class="C" package="com.x" resource-id="android:id/content" bounds="[0,0][50,50]" /></node>',
    );
    const r = resolveTap(parseUiHierarchy(xml), 25, 25, "com.x");
    expect(r?.tappedNode.resourceId).toBe("android:id/content");
    expect(r?.anchorNode?.resourceId).toBe("com.x:id/root");
    expect(r?.anchorSource).toBe("ancestor");
  });

  it("returns null when the point is outside every window", () => {
    const xml = wrap('<node class="R" package="p" bounds="[0,0][100,100]" />');
    expect(resolveTap(parseUiHierarchy(xml), 500, 500, "p")).toBeNull();
  });
});

describe("resolveTap — clickable scrim vs transparent overlay", () => {
  // One window: Main content + a later, full-screen clickable Scrim sibling
  // whose Sheet child sits elsewhere. The modal-scrim false-positive codex
  // caught — a same-window clickable hollow overlay must NOT pass through.
  const scrimXml =
    "<hierarchy>" +
    '<node class="Root" package="p" bounds="[0,0][100,100]">' +
    '<node class="Main" package="p" bounds="[0,0][100,100]">' +
    '<node class="MainBtn" package="p" resource-id="p:id/main_btn" bounds="[0,0][100,100]" /></node>' +
    '<node class="Scrim" package="p" resource-id="p:id/scrim" clickable="true" bounds="[0,0][100,100]">' +
    '<node class="Sheet" package="p" resource-id="p:id/sheet" bounds="[0,60][100,100]" /></node>' +
    "</node></hierarchy>";

  it("a clickable hollow scrim consumes the tap, not the content beneath", () => {
    const r = resolveTap(parseUiHierarchy(scrimXml), 20, 20, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/scrim");
  });

  it("a tap on the sheet still resolves into the sheet", () => {
    const r = resolveTap(parseUiHierarchy(scrimXml), 50, 80, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/sheet");
  });

  it("a non-clickable hollow overlay still passes through to the content", () => {
    const xml =
      "<hierarchy>" +
      '<node class="Root" package="p" bounds="[0,0][100,100]">' +
      '<node class="Main" package="p" bounds="[0,0][100,100]">' +
      '<node class="MainBtn" package="p" resource-id="p:id/main_btn" bounds="[0,0][100,100]" /></node>' +
      '<node class="Overlay" package="p" resource-id="p:id/overlay" clickable="false" bounds="[0,0][100,100]">' +
      '<node class="Corner" package="p" resource-id="p:id/corner" bounds="[90,90][100,100]" /></node>' +
      "</node></hierarchy>";
    const r = resolveTap(parseUiHierarchy(xml), 20, 20, "p");
    expect(r?.tappedNode.resourceId).toBe("p:id/main_btn");
  });
});

describe("resolveTap — RecyclerView row (Poppo follow list real device)", () => {
  // Real Poppo 关注/粉丝列表 dump (POCO F3 / 951a20a2). The first row's avatar
  // sits at [46,530][183,667]; (114, 598) is its center. The fixture protects
  // scenario E's contract: a tap on a recycled row child surfaces an
  // app-anchored tappedNode whose ancestor chain carries the RecyclerView —
  // exactly what `confidence.ts`'s `recycled_row_id` signal keys on.
  const roots = parseUiHierarchy(fixture("poppo-follow-list.xml"));

  it("a tap on a row avatar resolves to that avatar as its own anchor", () => {
    const r = resolveTap(roots, 114, 598, "com.baitu.poppo");
    expect(r).not.toBeNull();
    expect(r?.tappedNode.resourceId).toBe("com.baitu.poppo:id/avatar");
    expect(r?.anchorSource).toBe("tapped_node");
  });

  it("the ancestor chain contains a RecyclerView, enabling recycled_row_id detection", () => {
    const r = resolveTap(roots, 114, 598, "com.baitu.poppo");
    expect(r?.ancestorChain.some((n) => n.class.includes("RecyclerView"))).toBe(true);
  });
});

describe("resolveTap — share dialog overlay (Poppo real device)", () => {
  // Real Poppo 分享 dialog dump (POCO F3 / 951a20a2). Poppo's BottomSheet
  // attaches via the activity's ContentView rather than a separate window, so
  // uiautomator only emits the dialog subtree — root bounds are
  // [0,1399][1080,2320] (non-fullscreen). Inside, three nested RecyclerViews
  // (`recyclerViewShare`, `recyclerViewChatPlatform`, `recyclerViewOperation`)
  // exercise dense recycled-row content; (378, 1968) is the Facebook row's
  // avatar in `recyclerViewChatPlatform`.
  const roots = parseUiHierarchy(fixture("poppo-overlay.xml"));

  it("a tap on a dialog row resolves to its app-anchored ivAvatar", () => {
    const r = resolveTap(roots, 378, 1968, "com.baitu.poppo");
    expect(r?.tappedNode.resourceId).toBe("com.baitu.poppo:id/ivAvatar");
    expect(r?.anchorSource).toBe("tapped_node");
  });

  it("the ancestor chain pins the containing RecyclerView by id", () => {
    const r = resolveTap(roots, 378, 1968, "com.baitu.poppo");
    expect(
      r?.ancestorChain.some((n) => n.resourceId === "com.baitu.poppo:id/recyclerViewChatPlatform"),
    ).toBe(true);
    expect(r?.ancestorChain.some((n) => n.class.includes("RecyclerView"))).toBe(true);
  });

  it("a tap above the non-fullscreen dialog returns null", () => {
    // Dialog root starts at y=1399; (500, 700) is well above it.
    expect(resolveTap(roots, 500, 700, "com.baitu.poppo")).toBeNull();
  });
});
