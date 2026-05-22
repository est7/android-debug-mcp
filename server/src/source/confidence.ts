import { basename, extname } from "node:path";
import type { SourceCandidate, SourceCandidateKind } from "./candidate.ts";
import { parseResourceId } from "./recipe.ts";

/**
 * Confidence model for v2-A chain M (design lock Q7).
 *
 * Deduces, from the recipe's {@link SourceCandidate}s plus the runtime context
 * of the tap, *how trustworthy* the source mapping is — a graded verdict
 * (`high`/`medium`/`low`/`none`) plus a human `reason` and a machine-readable
 * `signals[]`. The dominant disambiguator is the foreground-Activity
 * cross-check: when an id is declared in several layouts, the Activity that is
 * actually on screen is what pins down the right one.
 *
 * Pure function — no IO, no device. Phase 4's `map_ui_node_to_source` tool
 * feeds it the recipe output and the agent-supplied node identity.
 */

export type Confidence = "high" | "medium" | "low" | "none";

/**
 * The eight machine-readable signals (design lock § Q7). Order is the output
 * order of {@link ConfidenceResult.signals}; do not reorder — it is contract.
 */
export const CONFIDENCE_SIGNALS = [
  "resource_id_present",
  "resource_package_matches_session",
  "layout_declares_id",
  "layout_inflated_by_foreground_activity",
  "code_refs_found",
  "owner_ambiguous",
  "framework_resource_id",
  "recycled_row_id",
] as const;

export type ConfidenceSignal = (typeof CONFIDENCE_SIGNALS)[number];

/** The fields of a v2-A `Node` that confidence evaluation reads. A full Node is assignable. */
export interface NodeView {
  /** `resource-id`, e.g. `com.baitu.poppo:id/login_button`; `null` when absent. */
  readonly resourceId: string | null;
  /** Runtime view class, e.g. `androidx.recyclerview.widget.RecyclerView`. */
  readonly class: string;
}

export interface ConfidenceInput {
  /** The recipe's source candidates for the tapped id (Phase 2.1). */
  readonly candidates: readonly SourceCandidate[];
  /** The nearest app-package resource-id node, or `null` when none was found. */
  readonly anchorNode: NodeView | null;
  /** dumpsys foreground Activity (`pkg/.path.Class`), or `null` when unknown. */
  readonly foregroundActivity: string | null;
  /** Strict ancestor chain of the tapped node; class names drive RecyclerView detection. */
  readonly ancestorChain: readonly NodeView[];
  /** The debug session's package — `resource_package_matches_session` compares against it. */
  readonly sessionPackage: string;
}

export interface ConfidenceResult {
  readonly confidence: Confidence;
  /** Human-readable justification for the tier. */
  readonly reason: string;
  /** The signals that evaluated TRUE, in {@link CONFIDENCE_SIGNALS} order. */
  readonly signals: ConfidenceSignal[];
}

/** Resource-id namespaces that are framework-owned, never a source anchor (design lock Q4). */
const FRAMEWORK_PACKAGES = new Set(["android"]);

/** View-class fragments that mark a recycling container — its child ids are reused across rows. */
const RECYCLER_CLASS_HINTS = ["RecyclerView", "ListView", "GridView"];

/**
 * Grade a source mapping. See the file header for the model; the tier ladder
 * (design lock § confidence 分级判据):
 *
 *   - `none`   — no app-package resource-id anchor, or nothing found.
 *   - `low`    — a recycled-row id, or an id declared in several layouts the
 *                foreground Activity cannot disambiguate.
 *   - `high`   — a single resolved screen owner (uniquely declared, or
 *                foreground-confirmed) that also references the view in code.
 *   - `medium` — a screen owner resolved, but no direct code reference in it.
 */
export function evaluateConfidence(input: ConfidenceInput): ConfidenceResult {
  const anchorResourceId = input.anchorNode?.resourceId ?? null;
  const parsedAnchor = anchorResourceId !== null ? parseResourceId(anchorResourceId) : null;

  const idLayoutFiles = filesOfKind(input.candidates, "id_declaration");
  const ownerFiles = filesOfKind(input.candidates, "screen_owner");
  const codeRefFiles = filesOfKind(input.candidates, "code_ref");

  const foregroundSimpleName = foregroundActivitySimpleName(input.foregroundActivity);
  const foregroundMatchedOwners =
    foregroundSimpleName === null
      ? []
      : [...ownerFiles].filter((file) => classFileSimpleName(file) === foregroundSimpleName);
  const handlerInOwner = [...codeRefFiles].some((file) => ownerFiles.has(file));

  const flags: Record<ConfidenceSignal, boolean> = {
    resource_id_present: anchorResourceId !== null,
    resource_package_matches_session:
      parsedAnchor !== null && parsedAnchor.pkg === input.sessionPackage,
    layout_declares_id: idLayoutFiles.size > 0,
    layout_inflated_by_foreground_activity: foregroundMatchedOwners.length > 0,
    code_refs_found: codeRefFiles.size > 0,
    // Multiple declaring layouts that the foreground Activity cannot narrow to
    // exactly one owner — the dominant `low` driver.
    owner_ambiguous: idLayoutFiles.size >= 2 && foregroundMatchedOwners.length !== 1,
    framework_resource_id: parsedAnchor !== null && FRAMEWORK_PACKAGES.has(parsedAnchor.pkg),
    recycled_row_id: input.ancestorChain.some((node) => isRecyclerClass(node.class)),
  };

  const verdict = classify(flags, {
    candidateCount: input.candidates.length,
    ownerResolved: ownerFiles.size > 0,
    handlerInOwner,
  });

  return {
    confidence: verdict.confidence,
    reason: verdict.reason,
    signals: CONFIDENCE_SIGNALS.filter((signal) => flags[signal]),
  };
}

interface ClassifyContext {
  readonly candidateCount: number;
  readonly ownerResolved: boolean;
  readonly handlerInOwner: boolean;
}

function classify(
  flags: Record<ConfidenceSignal, boolean>,
  ctx: ClassifyContext,
): { confidence: Confidence; reason: string } {
  if (!flags.resource_id_present) {
    return {
      confidence: "none",
      reason: "No resource-id anchor was provided; there is nothing to map.",
    };
  }
  if (!flags.resource_package_matches_session) {
    return {
      confidence: "none",
      reason: flags.framework_resource_id
        ? "The anchor is a framework resource-id (android:id/*), which is never a source anchor."
        : "The anchor's resource-id is not in the session package, so it cannot be mapped to this app's source.",
    };
  }
  if (ctx.candidateCount === 0) {
    return {
      confidence: "none",
      reason: "No layout or code in the project declares or references this resource-id.",
    };
  }
  // An id reused across recycled rows caps confidence regardless of how clean
  // the rest of the evidence is — the source is the row template, but which
  // row was tapped is unknowable from the id alone (design lock Q4).
  if (flags.recycled_row_id) {
    return {
      confidence: "low",
      reason:
        "The tapped node sits inside a recycling container (RecyclerView/ListView/GridView); its id is reused across rows, so confidence is capped.",
    };
  }
  if (flags.owner_ambiguous) {
    return {
      confidence: "low",
      reason:
        "The id is declared in multiple layouts and the foreground Activity does not single one out.",
    };
  }
  if (ctx.ownerResolved && ctx.handlerInOwner) {
    return {
      confidence: "high",
      reason: flags.layout_inflated_by_foreground_activity
        ? "The id resolves to a single screen owner, confirmed by the foreground Activity, with a code reference inside it."
        : "The id has a single declaration whose screen owner references the view in code.",
    };
  }
  if (ctx.ownerResolved) {
    return {
      confidence: "medium",
      reason:
        "A screen owner was resolved, but no direct code reference to the view was found inside it (the handler may be implicit, in an adapter, or in a base class).",
    };
  }
  return {
    confidence: "low",
    reason:
      "The resource-id was found in source, but no screen owner (Activity/Fragment) could be tied to it.",
  };
}

function filesOfKind(
  candidates: readonly SourceCandidate[],
  kind: SourceCandidateKind,
): Set<string> {
  return new Set(candidates.filter((c) => c.kind === kind).map((c) => c.file));
}

function isRecyclerClass(className: string): boolean {
  return RECYCLER_CLASS_HINTS.some((hint) => className.includes(hint));
}

/** `app/src/.../LoginActivity.kt` → `LoginActivity`. */
function classFileSimpleName(file: string): string {
  return basename(file, extname(file));
}

/**
 * `com.baitu.poppo/.modules.home.HomeActivity` → `HomeActivity`. Accepts a bare
 * class name, a `pkg/.Relative` component, or a `pkg/fully.Qualified` one.
 */
function foregroundActivitySimpleName(foregroundActivity: string | null): string | null {
  if (foregroundActivity === null || foregroundActivity.trim() === "") return null;
  const afterSlash = foregroundActivity.includes("/")
    ? foregroundActivity.slice(foregroundActivity.lastIndexOf("/") + 1)
    : foregroundActivity;
  const simple = afterSlash.includes(".")
    ? afterSlash.slice(afterSlash.lastIndexOf(".") + 1)
    : afterSlash;
  return simple === "" ? null : simple;
}
