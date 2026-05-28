import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForegroundActivity } from "../../adb/app.ts";
import { captureScreenshot, captureUiDump } from "../../adb/capture.ts";
import { probeViewport } from "../../adb/viewport.ts";
import { AnnotateError, annotatePng, classShortLabel } from "../../annotate/annotate.ts";
import type { SessionManager } from "../../session/manager.ts";
import {
  ElementFilterSchema,
  applyElementFilter,
  captureElementLimitSchema,
} from "../../ui/element_filter.ts";
import { CollectElementsError, collectCurrentElements } from "../../ui/list_elements.ts";
import { summarizeUiXml } from "../../ui/summary.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const kindEnum = z.enum(["screenshot", "ui_dump"]);

const inputSchema = z
  .object({
    runId: runIdInput,
    kinds: z
      .array(kindEnum)
      .min(1, "kinds must list at least one of screenshot / ui_dump")
      .max(2, "kinds has at most 2 entries"),
    label: z.string().min(1, "label must be non-empty").max(200, "label too long").optional(),
    // v2-F.1. default false → keeps v2-F.0 capture behavior byte-identical.
    annotateElements: z.boolean().optional(),
    // v2-F.3 — server-side narrowing on the annotate path. Shared
    // `ElementFilterSchema` with `list_elements`. `limit` is the
    // raw-optional variant (no schema default) so the F3-Q7 reject can
    // distinguish caller-supplied `limit:100` from omitted; handler
    // applies the default itself on the annotate path.
    filter: ElementFilterSchema.optional(),
    limit: captureElementLimitSchema,
    // v2-F.2 § F2-Q7 — post-filter+truncate annotation subset. Each id is a
    // 1-based annotationId pointing into the freshly-collected, filter+
    // truncate-reduced element list FOR THIS CALL. Stale-ordinal model
    // (§ F2-Q7b): NOT durable element identity; agent must re-verify
    // bounds/text/class after each call if the UI may have changed.
    annotationIds: z.array(z.number().int().positive()).min(1).max(100).optional(),
  })
  .strict();

const uiSummarySchema = z
  .object({
    /** Resolved separately via `dumpsys` — the XML itself does not name the activity. */
    topActivity: z.string().nullable(),
    nodeCount: z.number().int(),
    clickableCount: z.number().int(),
  })
  .strict();

const boundsSchema = z
  .object({
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
  })
  .strict();

// v2-F.1 — byte-equivalent to v2-F.0 Element + leading annotationId. Authoritative
// definition: `server/src/ui/list_elements.ts:23-44`. If the v2-F.0 Element shape
// changes, this MUST follow in the same commit (design lock § Q5).
const annotationElementSchema = z
  .object({
    annotationId: z.number().int().positive(),
    resourceId: z.string().nullable(),
    class: z.string(),
    package: z.string(),
    text: z.string().nullable(),
    contentDesc: z.string().nullable(),
    hint: z.string().nullable(),
    bounds: boundsSchema,
    center: z.object({ x: z.number().int(), y: z.number().int() }).strict(),
    clickable: z.boolean(),
    focusable: z.boolean(),
    checkable: z.boolean(),
    windowIndex: z.number().int().nonnegative(),
    focused: z.literal(true).optional(),
    selected: z.literal(true).optional(),
    checked: z.literal(true).optional(),
  })
  .strict();

const annotationSchema = z
  .object({
    screenshotPath: z.string().nullable(),
    elementCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    elements: z.array(annotationElementSchema),
    // v2-F.3 — pre/post-filter/truncate counts mirror list_elements; agent
    // can spot truncation via `filteredCount > elementCount`.
    unfilteredCount: z.number().int().nonnegative(),
    filteredCount: z.number().int().nonnegative(),
    truncated: z.literal(true).optional(),
    // viewport_unknown lives here (capture top-level outputSchema stays strict
    // per v0.5.0 ship).
    warnings: z.array(z.string()).optional(),
    // v2-F.2 § F2-Q11 — subset audit. Present iff caller supplied
    // `annotationIds`; `subsetRequested` = original array length (pre-dedup),
    // `subsetApplied` = unique-and-in-range length actually drawn.
    subsetRequested: z.number().int().nonnegative().optional(),
    subsetApplied: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    // design lock § annotationSchema.refine — 4 invariants (v2-F.1) + v2-F.3
    // adds: filteredCount >= elementCount; v2-F.2 adds: subsetRequested
    // present iff subsetApplied present (both or neither).
    (a) => {
      const baseInvariants =
        (a.screenshotPath === null) === (a.error !== null) &&
        (a.error === null || (a.elements.length === 0 && a.elementCount === 0)) &&
        a.elementCount === a.elements.length &&
        a.filteredCount >= a.elementCount;
      const subsetPair = (a.subsetRequested === undefined) === (a.subsetApplied === undefined);
      return baseInvariants && subsetPair;
    },
    {
      message:
        "annotation invariants violated (screenshotPath ↔ error, error ⇒ empty, elementCount ≡ elements.length, filteredCount >= elementCount, subsetRequested/subsetApplied paired)",
    },
  );

const outputSchema = z
  .object({
    captureId: z.string(),
    capturedAt: z.string(),
    screenshotPath: z.string().optional(),
    uiDumpPath: z.string().nullable().optional(),
    uiSummary: uiSummarySchema.nullable().optional(),
    // v2-F.1. Undefined = annotate not requested. Present-and-error = soft-degrade
    // (raw screenshot still in top-level `screenshotPath`).
    annotation: annotationSchema.optional(),
  })
  .strict();

type CaptureStructured = z.input<typeof outputSchema>;
type AnnotationStructured = NonNullable<CaptureStructured["annotation"]>;

const description = [
  "Capture a screenshot and/or a UI hierarchy dump of the active session's device.",
  "",
  "Use when: the agent wants visual or structural evidence of the current screen — confirm a repro state, or inspect the view tree. Pass `annotateElements:true` (requires `screenshot` in kinds) to also receive a numbered-box overlay PNG + an inline `{annotationId, center, bounds, …}` mapping; saves a follow-up `list_elements` call when the agent intends to tap something visible. v2-F.2 — each badge also carries a short ASCII class label (e.g. `Button:1`, `EditText:5`) derived from the element's class FQCN so the agent can identify badge purpose without consulting the mapping.",
  "Args: `runId`; `kinds` — a non-empty list of `screenshot` and/or `ui_dump`; optional `label`; optional `annotateElements` (default `false`); optional `filter` (`{clickableOnly?, classContains?, textContains?, contentDescContains?, inViewport?}`) and `limit` (1-500, default 100 on the annotate path) which take effect ONLY when `annotateElements:true` and narrow the elements that get badge-drawn + mapped (same semantics as `list_elements` filter — AND composition, case-insensitive substrings, half-open viewport intersect); optional `annotationIds: number[]` (1-100 positive ints, annotate-only) which further trims the badge-drawn set to the listed annotationIds — applied AFTER `filter` + `limit`, accepts 1-based ordinals into the post-filter post-truncate list. Stale-ordinal model: `annotationIds` reference the FRESHLY collected list of THIS call only, never a durable element identity; if the UI changed since the agent saw badge `N`, the new badge `N` may be a different element. Always verify `annotation.elements[i].bounds` / `text` / `class` before tapping.",
  'Returns: `{captureId, capturedAt, screenshotPath?, uiDumpPath?, uiSummary?, annotation?}`; `annotation` is present iff `annotateElements:true` and holds `{screenshotPath, elementCount, error, elements, unfilteredCount, filteredCount, truncated?, warnings?, subsetRequested?, subsetApplied?}`. `unfilteredCount` is the raw dump size; `filteredCount` is post-filter pre-truncate; `elementCount === elements.length` is post-truncate AND post-subset. `truncated:true` means `limit` cut at least one filter match (agent should tighten `filter` and re-call). `warnings:["viewport_unknown"]` surfaces when `inViewport:true` was requested but `wm size` could not be probed. When `annotationIds` is supplied, `subsetRequested` is the caller-array length (pre-dedup) and `subsetApplied` is the unique-in-range count actually drawn; `annotation.elements[i].annotationId` keeps its post-filter post-truncate ordinal (not renumbered 1..len(subset)) so the badge "3" you see in the image matches `elements[*].annotationId === 3`. On soft-degrade, `annotation.screenshotPath:null` + `annotation.error:<code>` (counts all 0); the raw `screenshotPath` is unaffected.',
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `adb_not_found` when the adb binary is missing; `adb_command_failed` when a `screencap` / `uiautomator` adb command fails. `query_malformed` when `annotateElements:true` without `screenshot` in kinds, OR when `filter` / `limit` / `annotationIds` is supplied without `annotateElements:true`, OR when `filter` / `limit` fails per-field validation, OR when any `annotationIds[i]` falls outside `[1, filteredCount-after-truncate]` (the error message names the out-of-range id and the available count). A failed ui_dump yields `uiDumpPath:null` (not an error); annotate-side failure surfaces in `annotation.error`, not as a tool error.",
].join("\n");

/** Capture id: 12 hex chars — filename-safe and carries no caller-supplied data. */
function mintCaptureId(): string {
  return randomBytes(6).toString("hex");
}

function emptyAnnotation(error: string, subsetRequested?: number): AnnotationStructured {
  return {
    screenshotPath: null,
    elementCount: 0,
    error,
    elements: [],
    unfilteredCount: 0,
    filteredCount: 0,
    // v2-F.2: pair subsetRequested/subsetApplied. v0.5.4 audit blocker #1
    // — when caller supplied annotationIds but the path soft-degraded, the
    // helper used to receive only a boolean and emit `subsetRequested:0`,
    // which contradicted the public contract ("subsetRequested = caller-
    // array length pre-dedup"). v0.5.5 fix: caller passes the actual
    // requested count, so soft-degrade rows truthfully report e.g.
    // `{subsetRequested:3, subsetApplied:0}` for `annotationIds:[2,5,7]`.
    // When caller didn't supply (subsetRequested === undefined), both
    // fields stay omitted (paired-absent invariant).
    ...(subsetRequested !== undefined ? { subsetRequested, subsetApplied: 0 } : {}),
  };
}

/** Dedup + range-validate annotationIds; throw query_malformed on out-of-range.
 *  Returns the unique subset (Set order = ascending) AND the requested length
 *  (pre-dedup) for audit. */
function applyAnnotationIdsSubset(
  filteredTruncated: ReturnType<typeof applyElementFilter>,
  annotationIds: readonly number[],
  runId: string,
): {
  readonly subset: typeof filteredTruncated;
  readonly subsetRequested: number;
  readonly subsetApplied: number;
} {
  const subsetRequested = annotationIds.length;
  // Range check first (any single out-of-range id → query_malformed).
  for (const id of annotationIds) {
    if (id < 1 || id > filteredTruncated.length) {
      throw new ToolDomainError(
        "query_malformed",
        `annotationId ${id} out of range; current filter+truncate yields ${filteredTruncated.length} elements`,
        { runId, annotationId: id, available: filteredTruncated.length },
      );
    }
  }
  // Dedup; iterate ascending so output order is deterministic by id.
  const unique = Array.from(new Set(annotationIds)).sort((a, b) => a - b);
  const subset = unique.map((id) => {
    const el = filteredTruncated[id - 1];
    if (el === undefined) {
      // Defensive — range check above should make this unreachable.
      throw new Error(`v2-F.2 subset assertion: annotationId ${id} unexpectedly missing`);
    }
    return el;
  });
  return { subset, subsetRequested, subsetApplied: subset.length };
}

export function registerCapture(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_capture",
    {
      title: "Capture screenshot / UI dump",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      const captureId = mintCaptureId();
      const capturedAt = new Date().toISOString();
      const kinds = [...new Set(input.kinds)];
      const wantsAnnotate = input.annotateElements === true;
      const artifactsDir = join(session.runDir, "artifacts");

      // Handler-side guard. Cannot encode via `.refine()` on inputSchema because
      // ZodEffects is rejected by register.ts § G-4; same pattern as v0.4.0 Block A.
      if (wantsAnnotate && !kinds.includes("screenshot")) {
        throw new ToolDomainError(
          "query_malformed",
          "annotateElements:true requires kinds to include 'screenshot'.",
          { runId: input.runId },
        );
      }
      // v2-F.3 reject gate (Round 3 amendment): `filter` / `limit` are
      // annotate-only inputs. `limit` uses `captureElementLimitSchema`
      // (raw optional, no default), so `input.limit !== undefined`
      // unambiguously means "caller supplied a value" — including the
      // corner case `{limit:100}` that the v0.5.2 default-equality check
      // missed. F3-Q7: `wantsAnnotate === false && (filter !== undefined
      // || limit !== undefined) -> query_malformed`. v2-F.2 § F2-Q8 adds
      // `annotationIds` to the same guard.
      if (
        !wantsAnnotate &&
        (input.filter !== undefined ||
          input.limit !== undefined ||
          input.annotationIds !== undefined)
      ) {
        throw new ToolDomainError(
          "query_malformed",
          "filter / limit / annotationIds on capture only take effect when annotateElements:true.",
          { runId: input.runId },
        );
      }
      // On the annotate path, the 100 default is applied here (the schema
      // no longer auto-defaults; see captureElementLimitSchema doc).
      const effectiveLimit = input.limit ?? 100;

      const structured: CaptureStructured = { captureId, capturedAt };
      let uiDumpFailed = false;
      let annotateError: string | null = null;
      let annotatedElementCount = 0;
      // v2-F.3 audit-field state, surfaces in events.jsonl + commands.jsonl
      // for the annotate path. v0.5.2 audit blocker #2: the response carried
      // these counts but the persisted rows did not, so post-run analysis
      // could not reconstruct why an annotated capture returned fewer
      // elements. Now both rows include them.
      let auditUnfilteredCount = 0;
      let auditFilteredCount = 0;
      let auditTruncated = false;
      // v2-F.2 subset audit. Only emitted to audit row when caller supplied
      // `annotationIds`; surfaced in annotation.subsetRequested/subsetApplied.
      // v0.5.5 (audit blocker #1): soft-degrade `emptyAnnotation` now takes
      // the actual requested count (or undefined) so it never lies with
      // `subsetRequested:0` on a caller-supplied subset.
      let auditSubsetApplied: number | null = null;

      let screenshotBytes: Buffer | null = null;
      if (kinds.includes("screenshot")) {
        const path = join(artifactsDir, `screenshot-${captureId}.png`);
        await captureScreenshot(session.deviceSerial, path);
        structured.screenshotPath = path;
        // Defer reading until annotate path actually needs it; not loaded otherwise.
        if (wantsAnnotate) screenshotBytes = await readFile(path);
      }

      // Single UI dump serves both `ui_dump` kind (uiSummary) and annotate
      // (element list). When both are requested, codex post-impl audit #2 found
      // that running captureUiDump twice to the same path could let uiSummary
      // describe XML(t=T1) while the on-disk artifact ends up as XML(t=T2) if
      // the UI moves between dumps. One dump → both consumers read the same XML
      // → evidence is internally consistent.
      const needsUiDump = kinds.includes("ui_dump");
      const uiPath =
        needsUiDump || wantsAnnotate ? join(artifactsDir, `ui-${captureId}.xml`) : null;
      let uiXml: string | null = null;
      let uiElements: Awaited<ReturnType<typeof collectCurrentElements>>["elements"] | null = null;

      if (uiPath !== null) {
        if (wantsAnnotate) {
          // collectCurrentElements writes the file AND parses + collects in one pass.
          try {
            const r = await collectCurrentElements(session.deviceSerial, uiPath);
            uiXml = r.xml;
            uiElements = r.elements;
          } catch (err) {
            if (err instanceof CollectElementsError) {
              // dump-side failure: degrade annotate AND, if ui_dump was also
              // requested, surface as the standard ui_dump failure mode.
              if (needsUiDump) {
                uiDumpFailed = true;
                structured.uiDumpPath = null;
                structured.uiSummary = null;
              }
            } else throw err;
          }
        } else {
          // ui_dump only — light path: no parse/collect.
          const dump = await captureUiDump(session.deviceSerial, uiPath);
          if (dump.ok && dump.xml !== null) {
            uiXml = dump.xml;
          } else {
            uiDumpFailed = true;
            structured.uiDumpPath = null;
            structured.uiSummary = null;
          }
        }

        if (needsUiDump && uiXml !== null) {
          const xmlSummary = summarizeUiXml(uiXml);
          const fg = await getForegroundActivity(session.deviceSerial, session.packageName);
          structured.uiDumpPath = uiPath;
          structured.uiSummary = { topActivity: fg.activity, ...xmlSummary };
        }
      }

      if (wantsAnnotate) {
        let annotation: AnnotationStructured;
        if (uiElements === null) {
          // collect failed earlier → soft-degrade annotate. v0.5.5: pass
          // `input.annotationIds.length` so subsetRequested reflects the
          // caller's intent even though we couldn't compute the subset.
          annotateError = "annotate_elements_unavailable";
          annotation = emptyAnnotation(annotateError, input.annotationIds?.length);
        } else if (screenshotBytes === null) {
          // We enforced kinds.includes("screenshot") above; this is a handler bug.
          throw new Error("capture annotate path reached without screenshot bytes.");
        } else {
          // v2-F.3: filter + truncate happens BEFORE annotate so the badge
          // numbering matches the returned `annotation.elements`. Probe
          // viewport only if filter asks for it; probe failure is soft.
          const wantsViewport = input.filter?.inViewport === true;
          const viewport = wantsViewport ? await probeViewport(session.deviceSerial) : null;
          const viewportProbeFailed = wantsViewport && viewport === null;
          const unfiltered = uiElements;
          const filtered = applyElementFilter(unfiltered, input.filter, viewport);
          const trimmed =
            filtered.length > effectiveLimit ? filtered.slice(0, effectiveLimit) : filtered;
          const truncatedAnnotation = filtered.length > trimmed.length;
          const annotationWarnings: string[] = [];
          if (viewportProbeFailed) annotationWarnings.push("viewport_unknown");
          // Hand the counts out so appendCommand / appendEvent (below) can
          // persist them; this is the v0.5.3 fold-in of v0.5.2 audit
          // blocker #2.
          auditUnfilteredCount = unfiltered.length;
          auditFilteredCount = filtered.length;
          auditTruncated = truncatedAnnotation;

          // v2-F.2 § F2-Q7 — apply post-filter+truncate annotationIds subset.
          // `trimmed[i]` has annotationId `i+1` (1-based post-truncate ordinal).
          // When caller passes annotationIds, range-validate, dedup, sort
          // ascending — annotation.elements goes out in ascending order per
          // F2-Q9, and annotationId stays the trimmed ordinal (not renumbered
          // 1..len(subset)) per F2-Q10.
          let paintElements: Array<{
            annotationId: number;
            el: (typeof trimmed)[number];
          }>;
          let subsetRequested: number | null = null;
          let subsetApplied: number | null = null;
          if (input.annotationIds !== undefined) {
            const subset = applyAnnotationIdsSubset(trimmed, input.annotationIds, input.runId);
            subsetRequested = subset.subsetRequested;
            subsetApplied = subset.subsetApplied;
            auditSubsetApplied = subset.subsetApplied;
            // Recompute annotationId from the ORIGINAL trimmed position, not
            // the subset position — `applyAnnotationIdsSubset` already returns
            // elements in ascending annotationId order, but the IDs we want to
            // paint are the IDs the caller asked for (= position in trimmed).
            const sortedIds = Array.from(new Set(input.annotationIds)).sort((a, b) => a - b);
            paintElements = subset.subset.map((el, i) => ({
              annotationId: sortedIds[i] as number,
              el,
            }));
          } else {
            paintElements = trimmed.map((el, i) => ({ annotationId: i + 1, el }));
          }

          const annotatedPath = join(artifactsDir, `screenshot-${captureId}-annotated.png`);
          try {
            if (paintElements.length === 0) {
              // design lock § S2 — empty element list writes a byte-identical
              // copy of the original screenshot (no decode/re-encode round trip,
              // which pngjs does not guarantee to be byte-stable).
              await writeFile(annotatedPath, screenshotBytes);
            } else {
              const inputs = paintElements.map(({ annotationId, el }) => ({
                annotationId,
                bounds: {
                  l: el.bounds.left,
                  t: el.bounds.top,
                  r: el.bounds.right,
                  b: el.bounds.bottom,
                },
                // v2-F.2 § F2-Q3 — derive label from class FQCN; empty class
                // falls through to label-less badge (renderer treats "" as
                // digit-only).
                label: classShortLabel(el.class),
              }));
              const result = annotatePng(screenshotBytes, inputs);
              await writeFile(annotatedPath, result.png);
            }
            annotation = {
              screenshotPath: annotatedPath,
              elementCount: paintElements.length,
              error: null,
              elements: paintElements.map(({ annotationId, el }) => ({ annotationId, ...el })),
              unfilteredCount: unfiltered.length,
              filteredCount: filtered.length,
              ...(truncatedAnnotation ? { truncated: true as const } : {}),
              ...(annotationWarnings.length > 0 ? { warnings: annotationWarnings } : {}),
              ...(subsetRequested !== null
                ? { subsetRequested, subsetApplied: subsetApplied as number }
                : {}),
            };
            annotatedElementCount = paintElements.length;
          } catch (err) {
            // ONLY AnnotateError soft-degrades; everything else (writeFile IO,
            // pngjs unexpected throw, programmer bug) propagates as a real tool
            // error per design lock § 失败语义. codex post-impl audit #1 — no
            // catch-all undocumented `annotate_unknown_failure` code.
            if (err instanceof AnnotateError) {
              annotateError = err.code;
              // v0.5.5: at this point we may have already computed
              // subsetRequested in the try-block (if applyAnnotationIdsSubset
              // succeeded but annotate-side then failed); fall back to the
              // raw input length when the try-block aborted before computing.
              annotation = emptyAnnotation(
                err.code,
                subsetRequested ?? input.annotationIds?.length,
              );
            } else {
              throw err;
            }
          }
        }
        structured.annotation = annotation;
      }

      // v2-F.3 audit-row payload — only present on the annotate path, where
      // filter/limit/counts are meaningful. Bundling here keeps appendCommand
      // and appendEvent in sync.
      const annotateAuditFields = wantsAnnotate
        ? {
            unfilteredElementCount: auditUnfilteredCount,
            filteredElementCount: auditFilteredCount,
            ...(input.filter !== undefined ? { filter: input.filter } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(auditTruncated ? { truncated: true as const } : {}),
            // v2-F.2 § F2-Q11: subset audit. `annotationIds` original (pre-dedup)
            // array preserved for audit consumer; `subsetApplied` is unique-and-
            // in-range count (post-dedup). Omitted entirely when caller didn't
            // supply (audit row stays narrow for the common non-subset path).
            ...(input.annotationIds !== undefined
              ? {
                  annotationIds: input.annotationIds,
                  subsetApplied: auditSubsetApplied ?? 0,
                }
              : {}),
          }
        : {};

      await session.appendCommand({
        tool: "capture",
        captureId,
        kinds,
        ...(wantsAnnotate ? { annotated: true } : {}),
        ...annotateAuditFields,
      });
      await session.appendEvent({
        type: "capture",
        captureId,
        kinds,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(uiDumpFailed ? { uiDumpFailed: true } : {}),
        ...(wantsAnnotate
          ? {
              annotated: true,
              annotatedElementCount,
              ...(annotateError !== null ? { annotateError } : {}),
            }
          : {}),
        ...annotateAuditFields,
      });
      return ok(structured);
    },
  );
}
