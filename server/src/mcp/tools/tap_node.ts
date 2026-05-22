import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForegroundActivity } from "../../adb/app.ts";
import { captureUiDump } from "../../adb/capture.ts";
import { inputTap } from "../../adb/input.ts";
import type { SessionManager } from "../../session/manager.ts";
import { UiHierarchyParseError, type UiNode, parseUiHierarchy } from "../../ui/hierarchy.ts";
import { resolveTap } from "../../ui/hit_test.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { coord, ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

/**
 * `android_debug_tap_node` — the v2-A atomic capture-then-tap tool.
 *
 * One call: dump the UI hierarchy, resolve which node sits under (x,y), THEN
 * tap. The dump runs BEFORE the tap so a dump failure aborts with no side
 * effect (design lock Q9). The recorded `tap_node` event is self-sufficient —
 * it carries the tapped node, its nearest app-package resource-id anchor, and
 * the ancestor chain — so source mapping (`map_ui_node_to_source`) can run
 * later off the event alone.
 */

const boundsSchema = z
  .object({
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
  })
  .strict();

/** Privacy-light node identity — no `text` / `content-desc` (design lock Q4/Q6). */
const nodeSchema = z
  .object({
    resourceId: z.string().nullable(),
    class: z.string(),
    package: z.string(),
    bounds: boundsSchema.nullable(),
    index: z.number().int().nullable(),
    clickable: z.boolean(),
    focusable: z.boolean(),
  })
  .strict();

type SerializedNode = z.infer<typeof nodeSchema>;

const inputSchema = z
  .object({
    runId: runIdInput,
    x: coord("x"),
    y: coord("y"),
    label: z.string().min(1, "label must be non-empty").max(200, "label too long").optional(),
  })
  .strict();

const outputSchema = z
  .object({
    ts: z.string(),
    preTapCaptureId: z.string(),
    preTapForegroundActivity: z.string().nullable(),
    tappedNode: nodeSchema,
    anchorNode: nodeSchema.nullable(),
    anchorSource: z.enum(["tapped_node", "ancestor", "none"]),
    ancestorChain: z.array(nodeSchema),
  })
  .strict();

const description = [
  "Tap a screen coordinate and resolve which UI element was hit, in one call.",
  "",
  "Use when: driving a tap-to-source debug flow — you need to know which view (and its resource-id source anchor) sits under a coordinate, not merely to dispatch the tap. For a plain tap with no node resolution, use `android_debug_tap`.",
  "Args: `runId`; `x` / `y` pixel coordinates (0-20000); optional `label` recorded in events.jsonl.",
  "Returns: `{ts, preTapCaptureId, preTapForegroundActivity, tappedNode, anchorNode, anchorSource, ancestorChain}` — the tapped node, its nearest app-package resource-id anchor (`null` when none), and the strict ancestor chain. The pre-tap UI hierarchy is saved to `artifacts/ui-<captureId>.xml`.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `ui_dump_failed` when the pre-tap `uiautomator dump` fails or is unparseable (the tap is NOT performed); `invalid_argument` when the coordinate is outside the captured UI (the tap is NOT performed); `adb_not_found` when the adb binary is missing; `adb_command_failed` when an adb command fails.",
].join("\n");

/** Project a parsed `UiNode` to the event shape — drops `children`. */
function serializeNode(node: UiNode): SerializedNode {
  return {
    resourceId: node.resourceId,
    class: node.class,
    package: node.package,
    bounds: node.bounds,
    index: node.index,
    clickable: node.clickable,
    focusable: node.focusable,
  };
}

export function registerTapNode(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_tap_node",
    {
      title: "Tap a coordinate and resolve the UI node",
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

      const captureId = randomBytes(6).toString("hex");
      const uiDumpPath = join(session.runDir, "artifacts", `ui-${captureId}.xml`);

      // Pre-tap hierarchy. Runs BEFORE the tap, so any failure here aborts with
      // no side effect — `tap_node`'s contract is tap-AND-tell, and a tap with
      // no resolvable node is a side effect of no evidence value (Q9).
      const dump = await captureUiDump(session.deviceSerial, uiDumpPath);
      if (!dump.ok || dump.xml === null) {
        throw new ToolDomainError(
          "ui_dump_failed",
          `pre-tap uiautomator dump failed; the tap was not performed: ${dump.detail}`,
          { runId: input.runId },
        );
      }

      let roots: UiNode[];
      try {
        roots = parseUiHierarchy(dump.xml);
      } catch (err) {
        if (err instanceof UiHierarchyParseError) {
          throw new ToolDomainError(
            "ui_dump_failed",
            `pre-tap UI hierarchy was unparseable; the tap was not performed: ${err.message}`,
            { runId: input.runId },
          );
        }
        throw err;
      }

      const resolution = resolveTap(roots, input.x, input.y, session.packageName);
      if (resolution === null) {
        throw new ToolDomainError(
          "invalid_argument",
          `tap coordinate (${input.x}, ${input.y}) is outside the captured UI hierarchy; the tap was not performed.`,
          { runId: input.runId, x: input.x, y: input.y },
        );
      }

      // Foreground activity is a pre-tap observation — capture it before the
      // tap, which may navigate away.
      const foreground = await getForegroundActivity(session.deviceSerial, session.packageName);

      await inputTap(session.deviceSerial, input.x, input.y);

      const tappedNode = serializeNode(resolution.tappedNode);
      const anchorNode =
        resolution.anchorNode === null ? null : serializeNode(resolution.anchorNode);
      const ancestorChain = resolution.ancestorChain.map(serializeNode);

      await session.appendCommand({ tool: "tap_node", adb: `input tap ${input.x} ${input.y}` });
      // The dump is first-class evidence — record it as a capture event so the
      // artifact is discoverable by run-management tools (design lock Q8).
      await session.appendEvent({ type: "capture", captureId, kinds: ["ui_dump"] });

      const ts = await session.appendEvent({
        type: "tap_node",
        x: input.x,
        y: input.y,
        preTapCaptureId: captureId,
        preTapForegroundActivity: foreground.activity,
        tappedNode,
        anchorNode,
        anchorSource: resolution.anchorSource,
        ancestorChain,
        ...(input.label !== undefined ? { label: input.label } : {}),
      });

      return ok({
        ts,
        preTapCaptureId: captureId,
        preTapForegroundActivity: foreground.activity,
        tappedNode,
        anchorNode,
        anchorSource: resolution.anchorSource,
        ancestorChain,
      });
    },
  );
}
