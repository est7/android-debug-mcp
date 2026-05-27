import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForegroundActivity } from "../../adb/app.ts";
import { captureScreenshot, captureUiDump } from "../../adb/capture.ts";
import { AnnotateError, annotatePng } from "../../annotate/annotate.ts";
import type { SessionManager } from "../../session/manager.ts";
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
  })
  .strict()
  .refine(
    // design lock § annotationSchema.refine — 4 invariants:
    //   (a) screenshotPath:null ⇔ error:string  (bi-directional)
    //   (b) error:string ⇒ elements.length === 0 ∧ elementCount === 0
    //   (c) elementCount === elements.length (success and failure)
    (a) =>
      (a.screenshotPath === null) === (a.error !== null) &&
      (a.error === null || (a.elements.length === 0 && a.elementCount === 0)) &&
      a.elementCount === a.elements.length,
    {
      message:
        "annotation invariants violated (screenshotPath ↔ error, error ⇒ empty, elementCount ≡ elements.length)",
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
  "Use when: the agent wants visual or structural evidence of the current screen — confirm a repro state, or inspect the view tree. Pass `annotateElements:true` (requires `screenshot` in kinds) to also receive a numbered-box overlay PNG + an inline `{annotationId, center, bounds, …}` mapping; saves a follow-up `list_elements` call when the agent intends to tap something visible.",
  "Args: `runId`; `kinds` — a non-empty list of `screenshot` and/or `ui_dump`; optional `label`; optional `annotateElements` (default `false`).",
  "Returns: `{captureId, capturedAt, screenshotPath?, uiDumpPath?, uiSummary?, annotation?}`; `annotation` is present iff `annotateElements:true` and holds `{screenshotPath, elementCount, error, elements}`. On soft-degrade, `annotation.screenshotPath:null` + `annotation.error:<code>` while the raw `screenshotPath` is unaffected.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `adb_not_found` when the adb binary is missing; `adb_command_failed` when a `screencap` / `uiautomator` adb command fails. `query_malformed` when `annotateElements:true` without `screenshot` in kinds. A failed ui_dump yields `uiDumpPath:null` (not an error); annotate-side failure surfaces in `annotation.error`, not as a tool error.",
].join("\n");

/** Capture id: 12 hex chars — filename-safe and carries no caller-supplied data. */
function mintCaptureId(): string {
  return randomBytes(6).toString("hex");
}

function emptyAnnotation(error: string): AnnotationStructured {
  return { screenshotPath: null, elementCount: 0, error, elements: [] };
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

      const structured: CaptureStructured = { captureId, capturedAt };
      let uiDumpFailed = false;
      let annotateError: string | null = null;
      let annotatedElementCount = 0;

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
          // collect failed earlier → soft-degrade annotate.
          annotateError = "annotate_elements_unavailable";
          annotation = emptyAnnotation(annotateError);
        } else if (screenshotBytes === null) {
          // We enforced kinds.includes("screenshot") above; this is a handler bug.
          throw new Error("capture annotate path reached without screenshot bytes.");
        } else {
          const annotatedPath = join(artifactsDir, `screenshot-${captureId}-annotated.png`);
          try {
            if (uiElements.length === 0) {
              // design lock § S2 — empty element list writes a byte-identical
              // copy of the original screenshot (no decode/re-encode round trip,
              // which pngjs does not guarantee to be byte-stable).
              await writeFile(annotatedPath, screenshotBytes);
            } else {
              const inputs = uiElements.map((el, i) => ({
                annotationId: i + 1,
                bounds: {
                  l: el.bounds.left,
                  t: el.bounds.top,
                  r: el.bounds.right,
                  b: el.bounds.bottom,
                },
              }));
              const result = annotatePng(screenshotBytes, inputs);
              await writeFile(annotatedPath, result.png);
            }
            annotation = {
              screenshotPath: annotatedPath,
              elementCount: uiElements.length,
              error: null,
              elements: uiElements.map((el, i) => ({ annotationId: i + 1, ...el })),
            };
            annotatedElementCount = uiElements.length;
          } catch (err) {
            // ONLY AnnotateError soft-degrades; everything else (writeFile IO,
            // pngjs unexpected throw, programmer bug) propagates as a real tool
            // error per design lock § 失败语义. codex post-impl audit #1 — no
            // catch-all undocumented `annotate_unknown_failure` code.
            if (err instanceof AnnotateError) {
              annotateError = err.code;
              annotation = emptyAnnotation(err.code);
            } else {
              throw err;
            }
          }
        }
        structured.annotation = annotation;
      }

      await session.appendCommand({
        tool: "capture",
        captureId,
        kinds,
        ...(wantsAnnotate ? { annotated: true } : {}),
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
      });
      return ok(structured);
    },
  );
}
