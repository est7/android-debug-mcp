import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput, touch } from "./_shared.ts";

/** § E-m3: JSON-serialized payload ceiling. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

const inputSchema = z
  .object({
    runId: runIdInput,
    name: z.string().regex(/^[a-z0-9_.-]{1,80}$/, "name must match ^[a-z0-9_.-]{1,80}$"),
    payload: z.unknown().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    ts: z.string(),
    name: z.string(),
  })
  .strict();

const description = [
  "Append a named semantic marker to the active session's events.jsonl, optionally with a JSON payload.",
  "",
  'Use when: the agent wants to anchor a point in time (e.g. "before_login", "after_crash_repro") so later evidence retrieval can be scoped relative to it.',
  "Args: `runId`; `name` matching `^[a-z0-9_.-]{1,80}$`; optional `payload` (any JSON value).",
  "Returns: `{ts, name}` — the ISO timestamp the marker was recorded at.",
  "Errors: `no_active_session` for an unknown runId; `event_payload_too_large` when the JSON-serialized payload exceeds 16 KiB.",
].join("\n");

export function registerMarkEvent(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_mark_event",
    {
      title: "Mark a session event",
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
      const session = manager.require(input.runId);
      touch(session);

      if (input.payload !== undefined) {
        const bytes = Buffer.byteLength(JSON.stringify(input.payload) ?? "", "utf8");
        if (bytes > MAX_PAYLOAD_BYTES) {
          throw new ToolDomainError(
            "event_payload_too_large",
            `mark_event payload is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`,
            { byteLength: bytes, limit: MAX_PAYLOAD_BYTES },
          );
        }
      }

      const ts = await session.appendEvent(
        input.payload !== undefined
          ? { type: "mark", name: input.name, payload: input.payload }
          : { type: "mark", name: input.name },
      );
      return ok({ ts, name: input.name });
    },
  );
}
