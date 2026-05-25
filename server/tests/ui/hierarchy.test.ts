import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UiHierarchyParseError, type UiNode, parseUiHierarchy } from "../../src/ui/hierarchy.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/ui/${name}`, import.meta.url)), "utf8");
}

function flatten(nodes: readonly UiNode[]): UiNode[] {
  const out: UiNode[] = [];
  const walk = (n: UiNode): void => {
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out;
}

describe("parseUiHierarchy — real device dump (Poppo HomepageActivity)", () => {
  const roots = parseUiHierarchy(fixture("poppo-homepage.xml"));
  const all = flatten(roots);

  it("parses the single-line dump into a deep tree", () => {
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(all.length).toBeGreaterThan(100);
  });

  it("extracts a known node with its parsed bounds and package", () => {
    const topBar = all.find((n) => n.resourceId === "com.baitu.poppo:id/cl_top_bar");
    expect(topBar).toBeDefined();
    expect(topBar?.bounds).toEqual({ left: 0, top: 0, right: 1080, bottom: 206 });
    expect(topBar?.package).toBe("com.baitu.poppo");
  });

  it("maps an empty resource-id to null — never the empty string", () => {
    expect(all.some((n) => n.resourceId === null)).toBe(true);
    expect(all.every((n) => n.resourceId !== "")).toBe(true);
  });

  it("keeps a framework resource-id verbatim (anchor exclusion is hit_test's job)", () => {
    expect(all.some((n) => n.resourceId === "android:id/content")).toBe(true);
  });

  it("preserves resource-ids duplicated across reused list cells", () => {
    const tvContent = all.filter((n) => n.resourceId === "com.baitu.poppo:id/tv_content");
    expect(tvContent.length).toBeGreaterThan(1);
  });

  it("tolerates the NAF attribute appearing before index", () => {
    const back = all.find((n) => n.resourceId === "com.baitu.poppo:id/backButton");
    expect(back).toBeDefined();
    expect(back?.clickable).toBe(true);
  });
});

describe("parseUiHierarchy — formatted login fixture", () => {
  it("parses a pretty-printed (multi-line) dump the same way", () => {
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    expect(all.length).toBe(8);
    const btn = all.find((n) => n.resourceId === "com.example.app:id/login_button");
    expect(btn?.bounds).toEqual({ left: 48, top: 960, right: 1032, bottom: 1120 });
    expect(btn?.clickable).toBe(true);
    expect(btn?.class).toBe("android.widget.Button");
  });
});

describe("parseUiHierarchy — v2-F additive fields", () => {
  it("extracts non-empty text and normalizes empty text to null", () => {
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    const header = all.find((n) => n.resourceId === "com.example.app:id/header");
    expect(header?.text).toBe("Sign in");
    // The login root carries text="" — uiautomator emits the attribute as empty,
    // not absent; normalize to null so consumers handle "no text" uniformly.
    const root = all.find((n) => n.resourceId === "com.example.app:id/login_root");
    expect(root?.text).toBeNull();
  });

  it("extracts content-desc and normalizes empty to null", () => {
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    const username = all.find((n) => n.resourceId === "com.example.app:id/username");
    expect(username?.contentDesc).toBe("Username");
    const header = all.find((n) => n.resourceId === "com.example.app:id/header");
    expect(header?.contentDesc).toBeNull();
  });

  it("extracts hint from inline XML and treats absence as null", () => {
    const xml =
      '<hierarchy><node class="android.widget.EditText" package="p" bounds="[0,0][100,40]" hint="Search" /></hierarchy>';
    expect(parseUiHierarchy(xml)[0]?.hint).toBe("Search");
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    expect(all.every((n) => n.hint === null)).toBe(true);
  });

  it("extracts checkable=true from a real CheckBox; default false otherwise", () => {
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    const remember = all.find((n) => n.resourceId === "com.example.app:id/remember");
    expect(remember?.checkable).toBe(true);
    const header = all.find((n) => n.resourceId === "com.example.app:id/header");
    expect(header?.checkable).toBe(false);
  });

  it("extracts checked=true from inline XML", () => {
    const xml =
      '<hierarchy><node class="android.widget.CheckBox" package="p" bounds="[0,0][100,100]" checkable="true" checked="true" /></hierarchy>';
    const node = parseUiHierarchy(xml)[0];
    expect(node?.checkable).toBe(true);
    expect(node?.checked).toBe(true);
  });

  it("extracts focused=true from the username EditText", () => {
    const all = flatten(parseUiHierarchy(fixture("login.xml")));
    const username = all.find((n) => n.resourceId === "com.example.app:id/username");
    expect(username?.focused).toBe(true);
    const password = all.find((n) => n.resourceId === "com.example.app:id/password");
    expect(password?.focused).toBe(false);
  });

  it("extracts selected=true from a tab-strip node in poppo-homepage", () => {
    const all = flatten(parseUiHierarchy(fixture("poppo-homepage.xml")));
    const selectedTabs = all.filter(
      (n) => n.resourceId === "com.baitu.poppo:id/ivTabIcon" && n.selected,
    );
    expect(selectedTabs.length).toBeGreaterThanOrEqual(1);
  });

  it("defaults all four boolean state fields to false when attributes are absent", () => {
    const xml = '<hierarchy><node class="A" package="p" bounds="[0,0][1,1]" /></hierarchy>';
    const node = parseUiHierarchy(xml)[0];
    expect(node?.checkable).toBe(false);
    expect(node?.checked).toBe(false);
    expect(node?.focused).toBe(false);
    expect(node?.selected).toBe(false);
    expect(node?.text).toBeNull();
    expect(node?.contentDesc).toBeNull();
    expect(node?.hint).toBeNull();
  });
});

describe("parseUiHierarchy — edge cases", () => {
  it("an empty hierarchy yields no roots", () => {
    expect(parseUiHierarchy('<hierarchy rotation="0"></hierarchy>')).toEqual([]);
  });

  it("returns multiple roots when <hierarchy> holds multiple windows", () => {
    const xml =
      '<hierarchy><node index="0" class="A" package="p" bounds="[0,0][10,10]" />' +
      '<node index="1" class="B" package="p" bounds="[0,0][10,10]" /></hierarchy>';
    expect(parseUiHierarchy(xml).length).toBe(2);
  });

  it("unparseable bounds become null, not a throw", () => {
    const xml = '<hierarchy><node class="A" package="p" bounds="garbage" /></hierarchy>';
    expect(parseUiHierarchy(xml)[0]?.bounds).toBeNull();
  });

  it("a missing bounds attribute is null", () => {
    expect(
      parseUiHierarchy('<hierarchy><node class="A" package="p" /></hierarchy>')[0]?.bounds,
    ).toBeNull();
  });

  it("a non-numeric index is null", () => {
    const xml = '<hierarchy><node index="x" class="A" package="p" /></hierarchy>';
    expect(parseUiHierarchy(xml)[0]?.index).toBeNull();
  });

  it("decodes XML entities in attribute values", () => {
    const xml = '<hierarchy><node class="A" package="p" resource-id="a&amp;b" /></hierarchy>';
    expect(parseUiHierarchy(xml)[0]?.resourceId).toBe("a&b");
  });

  it("a `>` inside an attribute value does not end the tag early", () => {
    const xml =
      '<hierarchy><node class="A" package="p" content-desc="2 > 1" resource-id="ok" /></hierarchy>';
    const roots = parseUiHierarchy(xml);
    expect(roots.length).toBe(1);
    expect(roots[0]?.resourceId).toBe("ok");
  });

  it("builds correct children for nested and self-closing nodes", () => {
    const xml =
      '<hierarchy><node class="P" package="p"><node class="C" package="p" /></node></hierarchy>';
    const roots = parseUiHierarchy(xml);
    expect(roots[0]?.children.length).toBe(1);
    expect(roots[0]?.children[0]?.class).toBe("C");
    expect(roots[0]?.children[0]?.children).toEqual([]);
  });

  it("throws on an unbalanced </node>", () => {
    expect(() => parseUiHierarchy("<hierarchy></node></hierarchy>")).toThrow(UiHierarchyParseError);
  });

  it("throws when there is no <hierarchy> root", () => {
    expect(() => parseUiHierarchy('<node class="A" package="p" />')).toThrow(UiHierarchyParseError);
  });

  it("throws on an unclosed <node>", () => {
    expect(() => parseUiHierarchy('<hierarchy><node class="A" package="p"></hierarchy>')).toThrow(
      UiHierarchyParseError,
    );
  });
});
