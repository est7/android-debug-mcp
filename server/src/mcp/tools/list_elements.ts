import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeViewport } from "../../adb/viewport.ts";
import type { SessionManager } from "../../session/manager.ts";
import {
  ElementFilterSchema,
  applyElementFilter,
  elementLimitSchema,
} from "../../ui/element_filter.ts";
import { CollectElementsError, collectCurrentElements } from "../../ui/list_elements.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

/**
 * `android_debug_list_elements` — v2-F element discovery (design lock § Q4–Q9).
 *
 * Every call runs a fresh `uiautomator dump` and returns the flat element list;
 * caching is explicitly forbidden in the tool description (the UI moves between
 * any two calls). Persistence mirrors `tap_node`: the dump becomes
 * `artifacts/ui-<captureId>.xml` plus a `{type:"capture", kinds:["ui_dump"]}`
 * event, and a separate `{type:"list_elements", elementCount, windowCount}`
 * event records the discovery without storing the element array itself — the
 * raw XML is already on disk.
 */

const boundsSchema = z
  .object({
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
  })
  .strict();

const elementSchema = z
  .object({
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
    windowIndex: z.number().int().min(0),
    focused: z.literal(true).optional(),
    selected: z.literal(true).optional(),
    checked: z.literal(true).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    runId: runIdInput,
    label: z.string().min(1, "label must be non-empty").max(200, "label too long").optional(),
    // v2-F.3 — server-side narrowing. Shared schema with capture annotate
    // path; see `docs/v2/element-interaction.md` § Amendments § v2-F.3.
    filter: ElementFilterSchema.optional(),
    limit: elementLimitSchema,
  })
  .strict();

const outputSchema = z
  .object({
    ts: z.string(),
    captureId: z.string(),
    elements: z.array(elementSchema),
    elementCount: z.number().int().min(0),
    windowCount: z.number().int().min(0),
    // v2-F.3 — pre-filter / post-filter / post-truncate counts let the
    // agent reason about narrowness (filteredCount / unfilteredCount) and
    // truncation (filteredCount > elementCount).
    unfilteredCount: z.number().int().min(0),
    filteredCount: z.number().int().min(0),
    truncated: z.literal(true).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const description = [
  "List interactive elements on the device screen. Do not cache this result; element coordinates change as the UI moves.",
  "",
  "Use when: an agent needs to discover what is on screen (resource-id / text / content-desc / hint / bounds + a pre-computed tap center) before driving a coordinate-based interaction — typically immediately before `android_debug_tap` / `android_debug_long_press` / `android_debug_swipe`. For tap-with-source-mapping use `android_debug_tap_node` instead.",
  "Args: `runId`; optional `label` recorded in the `list_elements` event; optional `filter` (`{clickableOnly?, classContains?, textContains?, contentDescContains?, inViewport?}`) to narrow at server-side — fields compose as AND, substring filters are case-insensitive, `inViewport` keeps only elements with at least one pixel inside `[0,w)×[0,h)`; optional `limit` (1-500, default 100) trims the post-filter list.",
  'Returns: `{ts, captureId, elements, elementCount, windowCount, unfilteredCount, filteredCount, truncated?, warnings?}` — `elements` is z-order topmost first (window 0 = topmost root), DFS post-order within each window. `unfilteredCount` is the raw dump size; `filteredCount` is the post-filter pre-truncate count; `elementCount === elements.length` is post-truncate. `truncated:true` appears when `filteredCount > elementCount` (limit cut at least one filter match) — agents seeing this should tighten `filter` and re-call. `warnings:["viewport_unknown"]` appears when `inViewport:true` was requested but `wm size` could not be probed (filter no-op for that field). The raw dump is saved to `artifacts/ui-<captureId>.xml`.',
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `ui_dump_failed` when the `uiautomator dump` fails or is unparseable; `query_malformed` when `filter` or `limit` fails per-field validation; `adb_not_found` when the adb binary is missing; `adb_command_failed` when an adb command fails.",
].join("\n");

export function registerListElements(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_list_elements",
    {
      title: "List on-screen interactive elements",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        // The handler materializes evidence: ui-<captureId>.xml on disk, a
        // `capture` event, a `list_elements` event, and a `commands.jsonl`
        // entry. That is the same shape as `android_debug_capture` and
        // `android_debug_tap_node`, which both declare `readOnlyHint:false`.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      const captureId = randomBytes(6).toString("hex");
      const uiDumpPath = join(session.runDir, "artifacts", `ui-${captureId}.xml`);

      let rawElements: Awaited<ReturnType<typeof collectCurrentElements>>["elements"];
      let windowCount: number;
      try {
        ({ elements: rawElements, windowCount } = await collectCurrentElements(
          session.deviceSerial,
          uiDumpPath,
        ));
      } catch (err) {
        if (err instanceof CollectElementsError) {
          throw new ToolDomainError("ui_dump_failed", err.detail, { runId: input.runId });
        }
        throw err;
      }

      // v2-F.3 — probe viewport only when `inViewport:true` is in play.
      // Probe failure is soft (returns null); caller surfaces `viewport_unknown`
      // warning and the filter no-ops for that field.
      const wantsViewport = input.filter?.inViewport === true;
      const viewport = wantsViewport ? await probeViewport(session.deviceSerial) : null;
      const viewportProbeFailed = wantsViewport && viewport === null;

      const filteredElements = applyElementFilter(rawElements, input.filter, viewport);
      const unfilteredCount = rawElements.length;
      const filteredCount = filteredElements.length;
      const elements =
        filteredCount > input.limit ? filteredElements.slice(0, input.limit) : filteredElements;
      const truncated = filteredCount > elements.length;
      const warnings: string[] = [];
      if (viewportProbeFailed) warnings.push("viewport_unknown");

      // Capture-mirror command shape: the underlying capture path covers
      // `/dev/tty` probe + file fallback + cleanup, so a single `adb:` literal
      // would not reflect the actual call set. The shape mirrors v1
      // `capture`'s persistence + ties this command to the artifact (open
      // implementation decision #5). v2-F.3 adds filter/limit/audit fields.
      await session.appendCommand({
        tool: "list_elements",
        captureId,
        kinds: ["ui_dump"],
        unfilteredCount,
        filteredCount,
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
        limit: input.limit,
        ...(truncated ? { truncated: true } : {}),
      });
      await session.appendEvent({ type: "capture", captureId, kinds: ["ui_dump"] });
      const ts = await session.appendEvent({
        type: "list_elements",
        captureId,
        elementCount: elements.length,
        windowCount,
        unfilteredCount,
        filteredCount,
        ...(input.filter !== undefined ? { filter: input.filter } : {}),
        limit: input.limit,
        ...(truncated ? { truncated: true } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      });

      return ok({
        ts,
        captureId,
        elements,
        elementCount: elements.length,
        windowCount,
        unfilteredCount,
        filteredCount,
        ...(truncated ? { truncated: true as const } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );
}
