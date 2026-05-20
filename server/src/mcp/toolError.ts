/**
 * Domain-error transport for MCP tools (open-decision #13).
 *
 * v1 treats a *domain* failure (no active session, ambiguous session, payload
 * too large, …) as a normal tool result the agent branches on — NOT a
 * JSON-RPC protocol error. A tool handler signals one by throwing
 * {@link ToolDomainError}; the register helper catches it and renders:
 *
 *   { content: [{ type: "text", text: JSON.stringify({error, message, ...}) }],
 *     isError: true }
 *
 * `isError: true` is MCP-correct for a tool *execution* failure and still lets
 * the agent read the structured `{error, message}` payload out of `content`.
 * A non-`ToolDomainError` throw is treated as a genuine bug and propagates as
 * a protocol-level error.
 *
 * The code catalog here is the Phase 3 subset; Phase 10 hardening completes it.
 */

export const TOOL_ERROR_CODES = {
  no_active_session: "no_active_session",
  ambiguous_active_session: "ambiguous_active_session",
  singleton_violation: "singleton_violation",
  run_missing: "run_missing",
  device_disconnected: "device_disconnected",
  input_method_unavailable: "input_method_unavailable",
  no_device: "no_device",
  ambiguous_device: "ambiguous_device",
  adb_not_found: "adb_not_found",
  event_payload_too_large: "event_payload_too_large",
  clear_blocked_by_active_session: "clear_blocked_by_active_session",
  confirmation_required: "confirmation_required",
  invalid_identity: "invalid_identity",
  app_control_failed: "app_control_failed",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];

export interface ToolErrorPayload {
  readonly error: ToolErrorCode;
  readonly message: string;
  readonly [key: string]: unknown;
}

export class ToolDomainError extends Error {
  readonly code: ToolErrorCode;
  readonly extra: Record<string, unknown>;
  constructor(code: ToolErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolDomainError";
    this.code = code;
    this.extra = extra;
  }

  toPayload(): ToolErrorPayload {
    return { error: this.code, message: this.message, ...this.extra };
  }
}
