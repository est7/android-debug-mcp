/**
 * Coordinate → UI node resolution for v2-A tap-to-source.
 *
 * Given a parsed uiautomator hierarchy and a tap coordinate, pick the node the
 * tap landed on and the nearest source-mappable anchor above it.
 *
 * Resolution order (design lock Q4, v2-A plan Phase 0):
 *  1. Topmost window — among `<hierarchy>` roots, the last in document order
 *     whose bounds contain the point. Search only its subtree.
 *  2. Descend, topmost child first (latest document order = topmost z-order).
 *     Commit to the first child that itself has a containing child (recurse)
 *     or is a leaf (the answer). A "hollow" non-leaf child — it contains the
 *     point but none of its children do — wins outright when it is clickable
 *     (an interactive scrim / click-catcher Android dispatches the tap to);
 *     a non-clickable hollow child is used only as a fallback when no sibling
 *     offers a deeper path. So a transparent overlay passes through to the
 *     content beneath, a modal scrim correctly stops the tap, and a
 *     genuinely-tapped empty container is kept when no alternative exists.
 *     Neither "globally deepest node" nor "always the last containing child"
 *     survives a real dump — both were tried and failed.
 *  3. The anchor is chosen only after the tapped node is fixed: the nearest
 *     node in [tappedNode, ...ancestors] whose resource-id belongs to the
 *     session package. Framework ids (`android:id/*`) never anchor.
 */

import type { UiBounds, UiNode } from "./hierarchy.ts";

/** Where the source anchor sits relative to the tapped node. */
export type AnchorSource = "tapped_node" | "ancestor" | "none";

export interface TapResolution {
  /** The node the tap landed on. */
  readonly tappedNode: UiNode;
  /** Nearest enclosing node with a session-package resource-id; `null` when none. */
  readonly anchorNode: UiNode | null;
  readonly anchorSource: AnchorSource;
  /** Strict ancestors of `tappedNode`, `[parent, …, windowRoot]`. */
  readonly ancestorChain: readonly UiNode[];
}

/**
 * Resolve a tap. Returns `null` only when the point lies outside every window
 * root — for an on-screen coordinate the full-screen root always matches.
 */
export function resolveTap(
  roots: readonly UiNode[],
  x: number,
  y: number,
  sessionPackage: string,
): TapResolution | null {
  const window = topmostWindow(roots, x, y);
  if (window === null) return null;

  const hit = descend(window, x, y, []);
  const lineage = [hit.node, ...hit.chain];
  const prefix = `${sessionPackage}:id/`;

  let anchorNode: UiNode | null = null;
  let anchorSource: AnchorSource = "none";
  for (let depth = 0; depth < lineage.length; depth++) {
    const node = lineage[depth];
    if (node?.resourceId?.startsWith(prefix)) {
      anchorNode = node;
      anchorSource = depth === 0 ? "tapped_node" : "ancestor";
      break;
    }
  }

  return { tappedNode: hit.node, anchorNode, anchorSource, ancestorChain: hit.chain };
}

/** The last (topmost in z-order) root whose bounds contain the point. */
function topmostWindow(roots: readonly UiNode[], x: number, y: number): UiNode | null {
  let topmost: UiNode | null = null;
  for (const root of roots) {
    if (containsPoint(root.bounds, x, y)) topmost = root;
  }
  return topmost;
}

interface Hit {
  readonly node: UiNode;
  /** `[parent, …, windowRoot]`. */
  readonly chain: UiNode[];
}

/**
 * Resolve the tap within `node`'s subtree. `node` contains the point;
 * `ancestors` is `[parent, …, windowRoot]`.
 */
function descend(node: UiNode, x: number, y: number, ancestors: UiNode[]): Hit {
  const childAncestors = [node, ...ancestors];
  let hollowFallback: UiNode | null = null;

  // Topmost (latest document order) first.
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (child === undefined || !containsPoint(child.bounds, x, y)) continue;

    if (hasContainingChild(child, x, y)) {
      return descend(child, x, y, childAncestors);
    }
    if (child.children.length === 0) {
      return { node: child, chain: childAncestors };
    }
    // Hollow non-leaf — contains the point but no child does. A clickable one
    // is an interactive scrim / click-catcher (modal backdrop, bottom-sheet
    // scrim): Android dispatches the tap to it, so it wins outright. A
    // non-clickable one is a transparent container — keep it only as a last
    // resort so an overlay falls through to the real content beneath.
    if (child.clickable) {
      return { node: child, chain: childAncestors };
    }
    if (hollowFallback === null) hollowFallback = child;
  }

  if (hollowFallback !== null) {
    return { node: hollowFallback, chain: childAncestors };
  }
  return { node, chain: ancestors };
}

/** Whether any direct child of `node` contains the point. */
function hasContainingChild(node: UiNode, x: number, y: number): boolean {
  for (const child of node.children) {
    if (containsPoint(child.bounds, x, y)) return true;
  }
  return false;
}

/** Half-open containment, `[left,right) × [top,bottom)`. Null or degenerate
 * bounds never contain a point — that is the validity filter (plan Phase 0). */
function containsPoint(bounds: UiBounds | null, x: number, y: number): boolean {
  if (bounds === null) return false;
  return bounds.left <= x && x < bounds.right && bounds.top <= y && y < bounds.bottom;
}
