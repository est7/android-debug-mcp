import { z } from "zod";
import type { PoppoHttpRecord } from "./record.ts";

/**
 * Agent-visible `query` schema for `search_evidence({source:"poppo_http"})`
 * and `extract_evidence_context({...query: {source:"poppo_http"}})`.
 *
 * Field choices (codex Phase 4 audit):
 *   - `pathPrefix`     — backlog Q4 explicit; schema § "MCP 消费指南" lists
 *     `path` as 主过滤键.
 *   - `methodIn`       — backlog Q4 explicit; capped at 10 to bound the
 *     filter cost.
 *   - `outcome`        — backlog Q4 explicit; mirrors schema § "失败有三种".
 *     Derivation cascade pinned in `derivePoppoHttpOutcome` (see comment).
 *   - `excludeHeartbeat` — backlog Q4 explicit; default false so the agent
 *     opts IN to filtering (heartbeat is noise but sometimes the bug).
 *   - `tsMsRange`      — backlog Q4 explicit + injected by
 *     `extract_evidence_context` for the marker window.
 *   - `hostContains`   — codex's preferred substring-search field (over the
 *     full-URL `urlContains` I'd originally proposed).
 *   - `durationMsGte`  — codex's "stronger schema support than urlContains"
 *     call: schema § "MCP 消费指南" lists `durationMs` as the slow-request
 *     query. Capped at 60_000 ms so a typo can't accept-everything via
 *     `durationMsGte: -1`.
 *
 * Top-level is `.strict()` per Phase 3 contract — caught by
 * `queryDispatch.dispatchQuery` as `query_malformed` if the agent adds an
 * unknown key.
 */
/**
 * Per-source window cap (v2-G.1 Block A tightening). `tsMsRange.to -
 * tsMsRange.from` must not exceed 24h on agent input. Hardcoded here per
 * Q5/Q8 — source-declared `evidenceWindowCapMs?` interface is a future
 * v2-G.X candidate (trigger: second source whose window need differs).
 */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PoppoHttpQuerySchema = z
  .object({
    source: z.literal("poppo_http"),
    pathPrefix: z.string().min(1).max(1024).optional(),
    methodIn: z.array(z.string().min(1).max(16)).min(1).max(10).optional(),
    outcome: z.enum(["ok", "http_error", "transport_error", "app_error"]).optional(),
    excludeHeartbeat: z.boolean().optional(),
    // v2-G.1 Block A tightening: both bounds required + 24h window cap.
    // Pre-tightening (v0.5.0) the schema accepted partial ranges, which let
    // an agent pass `{from: 0}` and effectively defeat narrowingFilter:
    // bindSession would clamp `from` up to sessionStartMs and the query
    // became "all traffic since session start". Hard cut, no shim — there
    // are no live callers at v0.5.0 cut (4a7e0e2). See preview-for-agent.md
    // § Q8 / § Q9.
    tsMsRange: z
      .object({
        from: z.number().int(),
        to: z.number().int(),
      })
      .strict()
      .refine((r) => r.to >= r.from, "tsMsRange.to must be >= tsMsRange.from")
      .refine(
        (r) => r.to - r.from <= MAX_WINDOW_MS,
        `tsMsRange window must be <= ${MAX_WINDOW_MS / 1000}s (24h) for poppo_http`,
      )
      .optional(),
    hostContains: z.string().min(1).max(255).optional(),
    durationMsGte: z.number().int().min(0).max(60_000).optional(),
    errorTypeIn: z.array(z.string().min(1).max(255)).min(1).max(10).optional(),
  })
  .strict();

export type PoppoHttpQuery = z.output<typeof PoppoHttpQuerySchema>;

/**
 * Derive the canonical "outcome" of a parsed record.
 *
 * # Cascade order (codex Phase 4 audit R4)
 *
 * Schema rev4 § "失败有三种" says HTTP error and business error are
 * orthogonal — a record CAN be both HTTP 500 AND `app.ok === false`. The
 * pre-audit draft cascaded `transport → app → http → ok`, which would have
 * classified HTTP 500 + `app.ok:false` as `app_error`. Codex's correction:
 * HTTP status takes precedence over business semantics — if the wire-level
 * response is non-2xx, the business envelope's `ok` field is no longer the
 * primary diagnostic.
 *
 *   1. `error != null`                                 → `transport_error`
 *   2. `response != null && status ∉ [200, 300)`       → `http_error`
 *   3. `response != null && app?.ok === false`         → `app_error`  (HTTP 2xx + business failure)
 *   4. otherwise                                       → `ok`
 *
 * Producer's exclusive `response`/`error` invariant (validated at parse
 * time) guarantees `(response === null) !== (error === null)`, so the four
 * branches are exhaustive.
 */
export function derivePoppoHttpOutcome(
  r: PoppoHttpRecord,
): "ok" | "http_error" | "transport_error" | "app_error" {
  if (r.error !== null) return "transport_error";
  // r.response is non-null past this point (schema invariant).
  const status = r.response?.status ?? 0;
  if (status < 200 || status >= 300) return "http_error";
  if (r.response?.app?.ok === false) return "app_error";
  return "ok";
}

/**
 * Pure predicate: does `record` satisfy `query`? Every field is independent
 * (AND-composed); missing query fields are no-op (don't filter).
 *
 * Per Phase 3 `EvidenceSource.matchQuery` contract, this MUST be pure —
 * no I/O, no closure over external state.
 */
export function matchPoppoHttpRecord(record: PoppoHttpRecord, query: PoppoHttpQuery): boolean {
  if (query.pathPrefix !== undefined && !record.path.startsWith(query.pathPrefix)) return false;

  if (query.methodIn !== undefined && !query.methodIn.includes(record.method)) return false;

  if (query.outcome !== undefined && derivePoppoHttpOutcome(record) !== query.outcome) {
    return false;
  }

  if (query.excludeHeartbeat === true && record.heartBeat === true) return false;

  if (query.tsMsRange !== undefined) {
    // Both bounds required at schema layer (v2-G.1 Block A tightening) — no
    // `!== undefined` guard needed on the individual fields.
    if (record.tsMs < query.tsMsRange.from) return false;
    if (record.tsMs > query.tsMsRange.to) return false;
  }

  if (query.hostContains !== undefined && !record.host.includes(query.hostContains)) {
    return false;
  }

  if (query.durationMsGte !== undefined && record.durationMs < query.durationMsGte) {
    return false;
  }

  if (query.errorTypeIn !== undefined) {
    if (record.error === null) return false;
    if (!query.errorTypeIn.includes(record.error.type)) return false;
  }

  return true;
}
