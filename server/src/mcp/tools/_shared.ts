import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import type { Session } from "../../session/session.ts";
import { ToolDomainError } from "../toolError.ts";

/** `runId` as accepted on tool input. Exact-match lookup happens in the manager. */
export const runIdInput = z.string().min(1, "runId required").max(64, "runId too long");

/**
 * A screen-pixel coordinate (§ G-4: every numeric input carries bounds). The
 * 20000 ceiling is generous enough for any current display while still
 * rejecting a runaway value; `axis` names the field so the Zod message is
 * specific (`x must be …`).
 */
export function coord(axis: string): z.ZodNumber {
  return z
    .number()
    .int(`${axis} must be an integer`)
    .min(0, `${axis} must be >= 0`)
    .max(20_000, `${axis} must be <= 20000`);
}

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

/**
 * Resolve an active session and assert its device is still reachable.
 *
 * `manager.require` is the `assertActiveSession` half (throws `no_active_session`
 * for an unknown runId); the `degraded` check is the `assertDeviceConnected`
 * half. Every device-touching interaction tool (`tap` / `input_text` /
 * `send_key` / `swipe` / `capture`) enters through here, so a disconnected
 * device fails with a clean `device_disconnected` domain error rather than a
 * raw adb exec failure. Phase 9 wires the health poll that flips a session to
 * `degraded`; until then the guard is dormant but the call sites are in place.
 */
export function requireConnectedSession(manager: SessionManager, runId: string): Session {
  const session = manager.require(runId);
  if (session.currentStatus === "degraded") {
    throw new ToolDomainError(
      "device_disconnected",
      `The device for session ${runId} is disconnected; reconnect and start a new session.`,
      { runId, deviceSerial: session.deviceSerial },
    );
  }
  return session;
}
