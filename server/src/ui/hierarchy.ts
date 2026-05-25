/**
 * uiautomator `dump` XML → a typed `UiNode` tree.
 *
 * Why a hand-written scanner — not the regex of `summary.ts`, not an XML DOM
 * dependency: v2-A hit-testing needs the real parent/child tree, and a real
 * `uiautomator dump` is one un-indented line, attributes in no fixed order
 * (`NAF` precedes `index` on some nodes), self-closing and nested `<node>`
 * mixed, and `<hierarchy>` sometimes holding more than one window root. The
 * scanner tracks quote state so a `>` inside an attribute value never ends a
 * tag early.
 *
 * Privacy boundary: this parser extracts `text` / `content-desc` / `hint` for
 * v2-F element-driven interaction (`list_elements` consumes them), but the
 * v2-A `tap_node` tool MUST NOT persist those fields into events.jsonl
 * (design lock Q4/Q6 — runtime text is translated user content). The sealant
 * lives in `tap_node`'s `serializeNode`, not here.
 */

export interface UiBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface UiNode {
  /** `resource-id`; `null` when the attribute is absent or empty — absence is semantic. */
  readonly resourceId: string | null;
  /** Runtime view class, e.g. `android.widget.Button`. */
  readonly class: string;
  /** Owning package — the device applicationId, e.g. `com.baitu.poppo`. */
  readonly package: string;
  /** Parsed `[l,t][r,b]`; `null` when absent or not four integers. */
  readonly bounds: UiBounds | null;
  /** uiautomator child `index`; `null` when absent or non-numeric. */
  readonly index: number | null;
  readonly clickable: boolean;
  readonly focusable: boolean;
  /** Runtime view text. `null` when the attribute is absent or empty. */
  readonly text: string | null;
  /** Accessibility `content-desc`. `null` when absent or empty. */
  readonly contentDesc: string | null;
  /** EditText placeholder hint. `null` when absent or empty. */
  readonly hint: string | null;
  readonly checkable: boolean;
  readonly checked: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  /** Child nodes, document order. */
  readonly children: readonly UiNode[];
}

/** Thrown when the XML tag structure is broken beyond recovery. */
export class UiHierarchyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiHierarchyParseError";
  }
}

interface MutableNode {
  resourceId: string | null;
  class: string;
  package: string;
  bounds: UiBounds | null;
  index: number | null;
  clickable: boolean;
  focusable: boolean;
  text: string | null;
  contentDesc: string | null;
  hint: string | null;
  checkable: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
  children: MutableNode[];
}

const ATTR_RE = /([\w:-]+)="([^"]*)"/g;
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;
const NAME_RE = /^\s*([\w:-]+)/;

/**
 * Parse a uiautomator dump into its window roots. `<hierarchy>` may hold more
 * than one child `<node>` (multi-window); each is returned as a root, in
 * document order.
 */
export function parseUiHierarchy(xml: string): UiNode[] {
  const len = xml.length;
  let cursor = 0;
  let sawHierarchy = false;
  const windows: MutableNode[] = [];
  const stack: MutableNode[] = [];

  while (cursor < len) {
    const lt = xml.indexOf("<", cursor);
    if (lt < 0) break;
    const gt = findTagEnd(xml, lt);
    const raw = xml.slice(lt + 1, gt);
    cursor = gt + 1;

    // Prolog `<?xml ?>` and comments `<!-- -->` carry nothing we need.
    if (raw.startsWith("?") || raw.startsWith("!")) continue;

    if (raw.startsWith("/")) {
      const closing = raw.slice(1).trim();
      if (closing === "hierarchy") continue;
      if (closing !== "node") continue;
      if (stack.length === 0) {
        throw new UiHierarchyParseError("unbalanced </node>");
      }
      stack.pop();
      continue;
    }

    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const name = NAME_RE.exec(body)?.[1] ?? "";

    if (name === "hierarchy") {
      sawHierarchy = true;
      continue;
    }
    if (name !== "node") continue;

    const node = buildNode(body);
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      windows.push(node);
    } else {
      parent.children.push(node);
    }
    if (!selfClose) stack.push(node);
  }

  if (!sawHierarchy) {
    throw new UiHierarchyParseError("no <hierarchy> root element");
  }
  if (stack.length > 0) {
    throw new UiHierarchyParseError(`${stack.length} unclosed <node> element(s)`);
  }
  return windows;
}

/** Index of the `>` that closes the tag opened at `lt`, skipping quoted spans. */
function findTagEnd(xml: string, lt: number): number {
  let inQuote = false;
  for (let j = lt + 1; j < xml.length; j++) {
    const c = xml[j];
    if (c === '"') inQuote = !inQuote;
    else if (c === ">" && !inQuote) return j;
  }
  throw new UiHierarchyParseError("unterminated tag");
}

function buildNode(body: string): MutableNode {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(body);
  while (m !== null) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) {
      attrs.set(key, decodeEntities(value));
    }
    m = ATTR_RE.exec(body);
  }
  const resourceId = attrs.get("resource-id");
  return {
    resourceId: resourceId === undefined || resourceId === "" ? null : resourceId,
    class: attrs.get("class") ?? "",
    package: attrs.get("package") ?? "",
    bounds: parseBounds(attrs.get("bounds")),
    index: parseIndex(attrs.get("index")),
    clickable: attrs.get("clickable") === "true",
    focusable: attrs.get("focusable") === "true",
    text: emptyToNull(attrs.get("text")),
    contentDesc: emptyToNull(attrs.get("content-desc")),
    hint: emptyToNull(attrs.get("hint")),
    checkable: attrs.get("checkable") === "true",
    checked: attrs.get("checked") === "true",
    focused: attrs.get("focused") === "true",
    selected: attrs.get("selected") === "true",
    children: [],
  };
}

/** Empty or missing string attribute → `null`; uiautomator emits `text=""` for
 * "no text" rather than omitting the attribute, and `null` makes the absence
 * semantic across both shapes. */
function emptyToNull(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

/** Parse `[l,t][r,b]`. Returns `null` for an absent or malformed value — a
 * data-level defect the caller (hit-testing) handles, not a parse failure. */
function parseBounds(raw: string | undefined): UiBounds | null {
  if (raw === undefined) return null;
  const m = BOUNDS_RE.exec(raw);
  if (m === null) return null;
  const [, left, top, right, bottom] = m;
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    return null;
  }
  return { left: Number(left), top: Number(top), right: Number(right), bottom: Number(bottom) };
}

function parseIndex(raw: string | undefined): number | null {
  if (raw === undefined || !/^-?\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Decode XML predefined entities AND numeric character references.
 *
 * uiautomator emits all non-ASCII characters (CJK, emoji, flag glyphs, bidi
 * controls) as numeric character references — `&#127477;&#127469;` is "🇵🇭",
 * not the literal text. v2-A's hidden-by-sealant `tap_node` never surfaced
 * this; v2-F `list_elements` returns `text` / `contentDesc` / `hint` directly
 * to the agent and an un-decoded `&#N;` would confuse downstream matching.
 *
 * `&amp;` is decoded LAST so an escaped reference like `&amp;#65;` survives as
 * the literal text `&#65;` rather than being double-decoded to `A`. */
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => decodeCodePoint(Number.parseInt(hex, 16)) ?? m)
    .replace(/&#(\d+);/g, (m, dec) => decodeCodePoint(Number.parseInt(dec, 10)) ?? m)
    .replace(/&amp;/g, "&");
}

/** Convert a Unicode code point to its `String` form, returning `null` for an
 * out-of-range value so the caller preserves the literal entity reference. */
function decodeCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  return String.fromCodePoint(code);
}
