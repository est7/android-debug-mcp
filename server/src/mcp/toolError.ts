/**
 * Domain-error transport for MCP tools (open-decision #13).
 *
 * v1 treats a *domain* failure (no active session, ambiguous session, payload
 * too large, a failed adb command, …) as a normal tool result the agent
 * branches on — NOT a JSON-RPC protocol error. The register helper renders two
 * throw kinds into the same `{isError:true}` envelope:
 *
 *   - {@link ToolDomainError} — a session / argument / policy failure a tool
 *     raises directly.
 *   - an `AdbError` (`adb/errors.ts`) — an adb-layer failure (`adb_not_found`,
 *     `adb_command_failed`, `device_disconnected`). Its `code` is part of this
 *     catalog, so every adb-touching tool surfaces the same error shape
 *     instead of leaking a raw protocol error.
 *
 * Rendered as:
 *   { content: [{ type: "text", text: JSON.stringify({error, message, ...}) }],
 *     isError: true }
 *
 * Any other throw is treated as a genuine bug and propagates as a protocol
 * error. The catalog was the v1-final set (Phase 10); v2-A tools append their
 * own codes below.
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
  adb_command_failed: "adb_command_failed",
  event_payload_too_large: "event_payload_too_large",
  confirmation_required: "confirmation_required",
  invalid_identity: "invalid_identity",
  invalid_cursor: "invalid_cursor",
  mark_not_found: "mark_not_found",
  invalid_argument: "invalid_argument",
  // v2-A chain T (tap_node):
  ui_dump_failed: "ui_dump_failed",
  // v2-A chain M (source mapping): surfaced by android_debug_map_ui_node_to_source.
  rg_not_found: "rg_not_found",
  search_timed_out: "search_timed_out",
  project_root_missing: "project_root_missing",
  // v2-G profile loader (Q11c): surfaced by start_session when
  // <projectRoot>/.android-debug-mcp/profile.json is broken or names an
  // unknown built-in profile. Hard errors so the run is never materialized
  // with a half-resolved adapter.
  profile_malformed: "profile_malformed",
  profile_unknown: "profile_unknown",
  // v2-G Phase 3: surfaced by search_evidence / extract_evidence_context when
  // `query` has a known `source` (it resolves against the runId's profile) but
  // the source-specific fields fail per-source strict zod validation
  // (Q4 inner discriminated-union). Distinct from `invalid_argument` so agents
  // can branch on "the source is real but my query shape is wrong" vs
  // "missing top-level field".
  query_malformed: "query_malformed",
  // v0.4.0 Block A "no fetch-all": surfaced by search_evidence when the
  // resolved source declares a `validateNarrowingFilter` and the agent's
  // (validly-shaped) query carries no positive narrowing field — only
  // `source` and / or negative filters. Distinct from `query_malformed` so
  // agents branch on "add a filter" vs "fix the field shape". Branchable
  // extras: {source: string}.
  query_underspecified: "query_underspecified",
  // v2-G Phase 5: surfaced by collect_bundle when evidence on disk cannot be
  // safely redacted — either metadata's profile name does not resolve via the
  // built-in registry, the run has evidence dirs but `metadata.profile` is
  // null (pre-Phase-3 run on a Phase-3+ binary), or an evidence/<id>/ dir
  // exists for a sourceId the resolved profile does not declare. Hard error
  // rather than silent skip: Q6 mandates redact at bundle export, and shipping
  // raw evidence past this boundary is exactly the security cliff Q6 prevents.
  // Branchable extras: {profileName: string | null, sourceId?: string}.
  evidence_redaction_unavailable: "evidence_redaction_unavailable",
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
