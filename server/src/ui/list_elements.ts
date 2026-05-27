/**
 * `UiNode[]` (parsed uiautomator hierarchy) → flat `Element[]` for v2-F
 * element-driven interaction (design lock § Q4–Q9).
 *
 * Filter `isUseful + hasPositiveBounds` keeps the list to nodes an agent can
 * realistically act on; unlabeled / zero-area containers are dropped. Roots
 * are walked in REVERSE document order so `windowIndex = 0` always points at
 * the z-order topmost root (v2-A `hit_test` already locked "doc-order last =
 * z-order topmost" — both sides stay consistent). DFS is post-order so leaves
 * emit before their containers, matching mobile-mcp.
 */

import { captureUiDump } from "../adb/capture.ts";
import { UiHierarchyParseError, type UiNode, parseUiHierarchy } from "./hierarchy.ts";

/**
 * One row of the `list_elements` tool result. Distinct from v2-A `Node`:
 * `Element` is flat (no `children`), carries a precomputed `center` for
 * direct tap dispatch, and tags `windowIndex` so an agent can reason about
 * multi-window stacks. State booleans (`focused` / `selected` / `checked`)
 * only appear when true — design lock § Element schema is explicit that
 * `false` here would mislead an LLM into thinking it is meaningful state.
 */
export interface Element {
  readonly resourceId: string | null;
  readonly class: string;
  readonly package: string;
  readonly text: string | null;
  readonly contentDesc: string | null;
  readonly hint: string | null;
  readonly bounds: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly center: { readonly x: number; readonly y: number };
  readonly clickable: boolean;
  readonly focusable: boolean;
  readonly checkable: boolean;
  readonly windowIndex: number;
  readonly focused?: true;
  readonly selected?: true;
  readonly checked?: true;
}

export function collectElements(roots: readonly UiNode[]): Element[] {
  const out: Element[] = [];
  // Reverse: window 0 = z-order topmost = doc-order last root (cf. hit_test).
  for (let i = roots.length - 1; i >= 0; i--) {
    const root = roots[i];
    if (root === undefined) continue;
    descend(root, roots.length - 1 - i, out);
  }
  return out;
}

function descend(node: UiNode, windowIndex: number, out: Element[]): void {
  for (const child of node.children) descend(child, windowIndex, out);
  if (!isUseful(node)) return;
  if (!hasPositiveBounds(node)) return;
  out.push(toElement(node, windowIndex));
}

function isUseful(node: UiNode): boolean {
  return Boolean(
    node.text ||
      node.contentDesc ||
      node.hint ||
      node.resourceId ||
      node.checkable ||
      node.clickable,
  );
}

function hasPositiveBounds(node: UiNode): boolean {
  const b = node.bounds;
  if (b === null) return false;
  return b.right > b.left && b.bottom > b.top;
}

function toElement(node: UiNode, windowIndex: number): Element {
  // bounds guaranteed non-null by hasPositiveBounds — narrow it here.
  const b = node.bounds as NonNullable<UiNode["bounds"]>;
  const base = {
    resourceId: node.resourceId,
    class: node.class,
    package: node.package,
    text: node.text,
    contentDesc: node.contentDesc,
    hint: node.hint,
    bounds: b,
    // Math.floor on both axes — odd bounds must NOT emit `.5` (agents tap
    // integer pixels; the floor keeps us inside the bounding box).
    center: { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) },
    clickable: node.clickable,
    focusable: node.focusable,
    checkable: node.checkable,
    windowIndex,
  };
  return {
    ...base,
    ...(node.focused ? { focused: true as const } : {}),
    ...(node.selected ? { selected: true as const } : {}),
    // `checked` is only meaningful on a checkable node; a `checked="true"` on a
    // non-checkable view is uiautomator noise we drop (design lock § Element
    // schema: "当 node.checkable=true 且 node.checked=true").
    ...(node.checkable && node.checked ? { checked: true as const } : {}),
  };
}

/** Typed failure of {@link collectCurrentElements}. Callers map `code` to their own tool-specific error. */
export class CollectElementsError extends Error {
  readonly code: "ui_dump_failed";
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "CollectElementsError";
    this.code = "ui_dump_failed";
    this.detail = detail;
  }
}

/**
 * Shared `dump → parse → collect` recipe used by both the `list_elements` tool
 * and `capture({annotateElements:true})`. Pure function: writes the dump XML
 * to `uiDumpPath` (caller owns path / captureId), parses it, returns
 * `{elements, windowCount, xml}`. Throws {@link CollectElementsError} on
 * dump-side failure; callers map to their tool-domain error type.
 *
 * v2-F.1 design lock § Open implementation decisions — codex round 2 #4
 * constrained the boundary:
 *   - Handler mints `captureId` / `uiDumpPath` / appendCommand / appendEvent.
 *   - Helper only performs `captureUiDump → parseUiHierarchy → collectElements`.
 *   - Never invokes the registered `list_elements` tool handler (event /
 *     privacy semantics belong to the calling tool).
 */
export async function collectCurrentElements(
  deviceSerial: string,
  uiDumpPath: string,
): Promise<{ readonly elements: Element[]; readonly windowCount: number; readonly xml: string }> {
  const dump = await captureUiDump(deviceSerial, uiDumpPath);
  if (!dump.ok || dump.xml === null) {
    throw new CollectElementsError(`uiautomator dump failed: ${dump.detail}`);
  }
  try {
    const roots = parseUiHierarchy(dump.xml);
    return { elements: collectElements(roots), windowCount: roots.length, xml: dump.xml };
  } catch (err) {
    if (err instanceof UiHierarchyParseError) {
      throw new CollectElementsError(`UI hierarchy was unparseable: ${err.message}`);
    }
    throw err;
  }
}
