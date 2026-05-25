import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureUiDump } from "../../adb/capture.ts";
import type { SessionManager } from "../../session/manager.ts";
import { UiHierarchyParseError, parseUiHierarchy } from "../../ui/hierarchy.ts";
import { collectElements } from "../../ui/list_elements.ts";
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
  })
  .strict();

const outputSchema = z
  .object({
    ts: z.string(),
    captureId: z.string(),
    elements: z.array(elementSchema),
    elementCount: z.number().int().min(0),
    windowCount: z.number().int().min(0),
  })
  .strict();

const description = [
  "List interactive elements on the device screen. Do not cache this result; element coordinates change as the UI moves.",
  "",
  "Use when: an agent needs to discover what is on screen (resource-id / text / content-desc / hint / bounds + a pre-computed tap center) before driving a coordinate-based interaction — typically immediately before `android_debug_tap` / `android_debug_long_press` / `android_debug_swipe`. For tap-with-source-mapping use `android_debug_tap_node` instead.",
  "Args: `runId`; optional `label` recorded in the `list_elements` event for timeline readability.",
  "Returns: `{ts, captureId, elements, elementCount, windowCount}` — `elements` is z-order topmost first (window 0 = topmost root), DFS post-order within each window; an empty list with `elementCount:0` is a normal soft result (screen blank or every node filtered out). The raw dump is saved to `artifacts/ui-<captureId>.xml`.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `ui_dump_failed` when the `uiautomator dump` fails or is unparseable; `adb_not_found` when the adb binary is missing; `adb_command_failed` when an adb command fails.",
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

      const dump = await captureUiDump(session.deviceSerial, uiDumpPath);
      if (!dump.ok || dump.xml === null) {
        throw new ToolDomainError("ui_dump_failed", `uiautomator dump failed: ${dump.detail}`, {
          runId: input.runId,
        });
      }

      let elements: ReturnType<typeof collectElements>;
      let windowCount: number;
      try {
        const roots = parseUiHierarchy(dump.xml);
        windowCount = roots.length;
        elements = collectElements(roots);
      } catch (err) {
        if (err instanceof UiHierarchyParseError) {
          throw new ToolDomainError(
            "ui_dump_failed",
            `UI hierarchy was unparseable: ${err.message}`,
            { runId: input.runId },
          );
        }
        throw err;
      }

      // Capture-mirror command shape: the underlying capture path covers
      // `/dev/tty` probe + file fallback + cleanup, so a single `adb:` literal
      // would not reflect the actual call set. The shape mirrors v1
      // `capture`'s persistence + ties this command to the artifact (open
      // implementation decision #5).
      await session.appendCommand({ tool: "list_elements", captureId, kinds: ["ui_dump"] });
      await session.appendEvent({ type: "capture", captureId, kinds: ["ui_dump"] });
      const ts = await session.appendEvent({
        type: "list_elements",
        captureId,
        elementCount: elements.length,
        windowCount,
        ...(input.label !== undefined ? { label: input.label } : {}),
      });

      return ok({
        ts,
        captureId,
        elements,
        elementCount: elements.length,
        windowCount,
      });
    },
  );
}
