/**
 * `uiautomator dump` XML summariser.
 *
 * Open decision #7: a zero-dependency regex parse, not an XML DOM. The full
 * hierarchy is always written verbatim to `artifacts/ui-<captureId>.xml`; this
 * module only derives the few counts an agent needs to decide whether the dump
 * is worth opening. A regex is sufficient because we count attribute
 * occurrences — we never need the tree structure here. Revisit (open #7) only
 * if a real dump produces a > 10% miscount.
 */

export interface UiXmlSummary {
  /** Total `<node>` elements in the hierarchy. */
  readonly nodeCount: number;
  /** Nodes carrying `clickable="true"` — a rough "how interactive is this screen". */
  readonly clickableCount: number;
}

const NODE_RE = /<node\b/g;
// A leading whitespace is required so `long-clickable="true"` is NOT counted —
// `\b` alone matches between the `-` and `clickable`, which would over-count.
const CLICKABLE_RE = /\sclickable="true"/g;

/** Count `<node>` elements and `clickable="true"` nodes in a uiautomator dump. */
export function summarizeUiXml(xml: string): UiXmlSummary {
  return {
    nodeCount: (xml.match(NODE_RE) ?? []).length,
    clickableCount: (xml.match(CLICKABLE_RE) ?? []).length,
  };
}
