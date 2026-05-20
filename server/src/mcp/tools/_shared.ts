import { z } from "zod";
import type { Session } from "../../session/session.ts";

/** `runId` as accepted on tool input. Exact-match lookup happens in the manager. */
export const runIdInput = z.string().min(1, "runId required").max(64, "runId too long");

/** Health snapshot shape shared by `get_app_state` and `get_run_summary`. */
export const sessionStatusSchema = z
  .object({
    device: z.enum(["connected", "degraded"]),
    logcat: z.enum(["running", "terminated", "stopped"]),
    startedAt: z.string(),
    lastLogAt: z.string().nullable(),
    lastCommandAt: z.string().nullable(),
  })
  .strict();

/** A single `text` content block. */
export function textContent(text: string): [{ type: "text"; text: string }] {
  return [{ type: "text", text }];
}

/** Build the dual content/structuredContent return for a successful tool call. */
export function ok<T extends Record<string, unknown>>(
  structuredContent: T,
): { structuredContent: T; content: [{ type: "text"; text: string }] } {
  return { structuredContent, content: textContent(JSON.stringify(structuredContent)) };
}

/** Common idle-timer touch every session-scoped tool performs on entry. */
export function touch(session: Session): void {
  session.touchCommand();
}
