import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getForegroundActivity } from "../../adb/app.ts";
import { captureScreenshot, captureUiDump } from "../../adb/capture.ts";
import type { SessionManager } from "../../session/manager.ts";
import { summarizeUiXml } from "../../ui/summary.ts";
import { registerDebugTool } from "../register.ts";
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

const outputSchema = z
  .object({
    captureId: z.string(),
    capturedAt: z.string(),
    screenshotPath: z.string().optional(),
    uiDumpPath: z.string().nullable().optional(),
    uiSummary: uiSummarySchema.nullable().optional(),
  })
  .strict();

type CaptureStructured = z.input<typeof outputSchema>;

const description = [
  "Capture a screenshot and/or a UI hierarchy dump of the active session's device.",
  "",
  "Use when: the agent wants visual or structural evidence of the current screen — confirm a repro state, or inspect the view tree.",
  "Args: `runId`; `kinds` — a non-empty list of `screenshot` and/or `ui_dump`; optional `label`.",
  "Returns: `{captureId, capturedAt, screenshotPath?, uiDumpPath?, uiSummary?}`; artifacts land under the run's `artifacts/`.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `adb_command_failed` when a `screencap` / `uiautomator` adb command fails. A failed ui_dump yields `uiDumpPath:null` (not an error); a screenshot that returns no PNG throws.",
].join("\n");

/** Capture id: 12 hex chars — filename-safe and carries no caller-supplied data. */
function mintCaptureId(): string {
  return randomBytes(6).toString("hex");
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
      const artifactsDir = join(session.runDir, "artifacts");

      const structured: CaptureStructured = { captureId, capturedAt };
      let uiDumpFailed = false;

      if (kinds.includes("screenshot")) {
        const path = join(artifactsDir, `screenshot-${captureId}.png`);
        await captureScreenshot(session.deviceSerial, path);
        structured.screenshotPath = path;
      }

      if (kinds.includes("ui_dump")) {
        const path = join(artifactsDir, `ui-${captureId}.xml`);
        const dump = await captureUiDump(session.deviceSerial, path);
        if (dump.ok && dump.xml !== null) {
          const xml = summarizeUiXml(dump.xml);
          const fg = await getForegroundActivity(session.deviceSerial, session.packageName);
          structured.uiDumpPath = path;
          structured.uiSummary = { topActivity: fg.activity, ...xml };
        } else {
          structured.uiDumpPath = null;
          structured.uiSummary = null;
          uiDumpFailed = true;
        }
      }

      await session.appendCommand({ tool: "capture", captureId, kinds });
      await session.appendEvent({
        type: "capture",
        captureId,
        kinds,
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(uiDumpFailed ? { uiDumpFailed: true } : {}),
      });
      return ok(structured);
    },
  );
}
