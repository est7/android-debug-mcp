import { z } from "zod";

/**
 * `<projectRoot>/.android-debug-mcp/profile.json` —— the per-project pointer
 * to a built-in profile (v2-G Q10).
 *
 *   - `name`    selects which built-in profile drives this session.
 *   - `version` is the profile.json *schema* version (not the profile content
 *               version). Reserved at `1` so a future schema rev can introduce
 *               overrides / extra fields under a SemVer bump and old readers
 *               reject unknown shapes loudly.
 */
export const ProfileJsonSchema = z
  .object({
    name: z.string().min(1).max(64),
    version: z.literal(1),
  })
  .strict();

export type ProfileJson = z.output<typeof ProfileJsonSchema>;

/**
 * Per-session runtime context handed to every `EvidenceSource` device-side
 * method. Phase 2 intentionally keeps this minimal: the source needs the
 * device address + the session-start ISO ms to time-window filter, plus the
 * device timezone to interpret filename-local-dates (Poppo HTTP log files
 * embed `yyyy-MM-dd` in the device's local zone — see schema rev4).
 *
 * Filesystem layout is NOT a source concern. `runDir`, `runDir/evidence/<id>/`,
 * mtime cache I/O, and pull destinations are all caller-managed (Phase 3
 * `search_evidence` / `extract_evidence_context` wiring). Keeping ctx narrow
 * makes sources hermetic and easy to test.
 */
export interface EvidenceContext {
  /** ADB device serial. Sources pass this through to `adb -s <serial> ...`. */
  readonly deviceSerial: string;
  /**
   * Resolved Android package name of the session. Sources that read from
   * the app's external files dir (`/sdcard/Android/data/<pkg>/files/...`)
   * use this to compose the device path. Phase 4 amendment — added when
   * the first concrete source (`poppo_http`) needed a per-app device path
   * (Poppo vs Vone share the source's logic but read from different package
   * dirs).
   */
  readonly packageName: string;
  /** Epoch ms of session start; left edge of the lazy-pull time window (Q5+). */
  readonly sessionStartMs: number;
  /**
   * `persist.sys.timezone` captured at start_session (IANA zone or null when
   * the device prop was unreadable). Sources that interpret filename-local
   * dates (poppo_http) must handle the null case — either skip the
   * date-window filter or fall back to mtime-only selection.
   */
  readonly deviceTimezone: string | null;
}

/**
 * One device-side file the source has identified as a candidate for pulling.
 * `mtimeMs` comes from `adb shell stat -c %Y` (multiplied to ms) and drives the
 * mtime cache lookup. `parsedDate` is deliberately absent — date parsing is
 * source-specific (Poppo HTTP log filenames carry `yyyy-MM-dd`; other sources
 * may not), so the source impl derives it internally as it pleases.
 */
export interface DeviceFileEntry {
  /** Absolute device path, e.g. `/sdcard/Android/data/<pkg>/files/http-logs/http_2026-05-26_0.jsonl`. */
  readonly path: string;
  /** Basename of `path`, included so the caller does not re-split. */
  readonly name: string;
  /** mtime in epoch ms. Drives `runDir/evidence/<id>/.mtime-cache.json` hit/miss. */
  readonly mtimeMs: number;
}

/**
 * A single parsed evidence record. Phase 2 keeps the shape open: `source` is
 * the only field every record must carry (so callers can dispatch on it post
 * `matchQuery`); concrete sources extend with their own fields. Phase 3's
 * `search_evidence` discriminates on `query.source` (Q4) so the source impl
 * downcasts `record` to its internal type via `as` before reading domain
 * fields — typed at the impl boundary, opaque at the interface boundary.
 *
 * # Reserved key: `_meta`
 *
 * `_meta` is a globally reserved key on `ParsedRecord` — `source.parseLine`
 * MUST NOT produce a record containing it. The runtime injects `_meta` as a
 * server-owned namespace for read-time metadata (currently only
 * `_meta.preview` from v2-G.1; future amendments may add `_meta.redaction`,
 * `_meta.cached`, etc. under the same namespace). A pre-projection invariant
 * in `evidence/runtime.ts` rejects any source-produced `_meta` regardless of
 * preview opt-in / hook declaration — see `preview-for-agent.md` § Q3 / Q5b
 * invariant #6.
 */
export interface ParsedRecord {
  readonly source: string;
  readonly [key: string]: unknown;
}

/**
 * Result returned by `EvidenceSource.previewForAgent?(record)` — the
 * agent-facing read-time projection that shrinks oversize records before
 * they go into the agent's context window (v2-G.1 Block B).
 *
 * Returned `record` is the source's preview-shaped record; the runtime
 * wraps it as `{ ...record, _meta: { preview: { truncated, fullSizeBytes,
 * truncatedFields } } }` before handing back to the caller. `fullSizeBytes`
 * is the UTF-8 JSON byte length of the raw (pre-truncation) record — agents
 * use this to decide whether to re-fetch with `fullRecords: true`.
 * `truncatedFields` enumerates dotted field paths that were lossily
 * mutated; empty array when `truncated:false`.
 *
 * Sources without `previewForAgent?` declared fall through to raw
 * passthrough (no `_meta.preview` injected; see `preview-for-agent.md` § Q11
 * three-row table). When declared, the hook fires for every record returned
 * by either `runStreamPath` or `runSortPath`, page-slice-after, after the
 * `_meta` reservation invariant has cleared.
 */
export interface PreviewResult {
  readonly record: ParsedRecord;
  readonly truncated: boolean;
  readonly fullSizeBytes: number;
  readonly truncatedFields: readonly string[];
}

/**
 * Placeholder for the Phase 3 `search_evidence` query union (Q4 discriminated
 * union by `source`). Like `ParsedRecord`, every query carries `source` as the
 * discriminator and the source impl downcasts internally. Phase 3 will land
 * the strict zod union at the tool boundary; until then this shape lets the
 * `EvidenceSource` contract type-check without forward-referencing tool-layer
 * schemas.
 */
export interface EvidenceQuery {
  readonly source: string;
  readonly [key: string]: unknown;
}

/**
 * Contract every concrete evidence source implements. Sources are PURE with
 * respect to the host filesystem — they only touch the device (via adb) and
 * transform record-shaped data; mtime caching, run-folder pathing, and event
 * bookkeeping all live in the Phase 3 tool wiring.
 *
 * Concrete impl arrives in Phase 4 (`poppo_http` for `http_*.jsonl` per
 * `submodulepoppo/docs/projects/http-log-jsonl-schema.md` rev4). Phase 2 ships
 * the interface + a fake impl in tests so the registry can ferry typed sources
 * through the system before any tool consumes them.
 */
export interface EvidenceSource {
  /** Stable identifier; matches the `source` literal in `search_evidence`'s
   * discriminated-union query (Q4). MUST be unique within a profile and
   * across the agent-visible MCP surface. */
  readonly id: string;

  /**
   * Strict zod schema for the source-specific `query` shape inside
   * `search_evidence` / `extract_evidence_context`.
   *
   * Q4 (discriminated-union at tool boundary) cannot be expressed as a single
   * static `z.discriminatedUnion` at the MCP `registerTool` call site because
   * (a) arms are profile-dependent (vanilla session has zero arms; zod refuses
   * to construct a zero-arm discriminated union) and (b) MCP requires the
   * input schema to be static at registration. So the tool boundary keeps
   * `query` loose (`z.object({ source: z.string() }).passthrough()`), the
   * handler looks up the source by `query.source`, then calls
   * `source.querySchema.parse(query)` for per-source strict validation.
   *
   * Concrete sources MUST:
   *   - Build the schema with `.strict()` so unknown keys are rejected.
   *   - Pin the discriminator with `source: z.literal(<this.id>)` so the
   *     schema itself enforces that records and queries agree on the source
   *     name (the dispatcher does NOT re-check `query.source === id` —
   *     it trusts the schema).
   *
   * Validation failure surfaces as `ToolDomainError("query_malformed")`,
   * not as a JSON-RPC protocol error — agents branch on it.
   */
  readonly querySchema: z.ZodTypeAny;

  /**
   * Enumerate device-side candidate files within the session's time window.
   * Implementations SHOULD apply the source's own filename-date heuristic
   * (e.g. `http_<yyyy-MM-dd>_*.jsonl` with a 1-day buffer for tz / cross-day
   * sessions) before issuing the per-file `stat` calls — listing should not
   * fan out to every historical log on disk.
   * Returns `[]` (not an error) when the device dir is absent.
   */
  listDeviceFiles(ctx: EvidenceContext): Promise<readonly DeviceFileEntry[]>;

  /**
   * Pull `deviceFile.path` to `localPath`. Wraps `adb pull`. Caller has already
   * decided the local path lives under `runDir/evidence/<source.id>/` and has
   * ensured the parent dir exists. Throws on adb failure — pulls are the
   * primary cost center and a silent miss would surface as empty search
   * results that are indistinguishable from "no records matched."
   */
  pullFile(ctx: EvidenceContext, deviceFile: DeviceFileEntry, localPath: string): Promise<void>;

  /**
   * Parse one line from a pulled file. Returns `null` to skip the line (e.g.
   * malformed JSON in an active file mid-write — Q5+ active-file half-line
   * tolerance — or a header/footer line the format does not need). MUST NOT
   * throw for malformed input; callers iterate line-by-line and skip nulls.
   */
  parseLine(line: string): ParsedRecord | null;

  /**
   * Predicate: does `record` satisfy `query`? Pre-condition: the caller has
   * already established `query.source === source.id` so the impl is free to
   * downcast both arguments to its own internal types via `as`. Pure — no I/O.
   */
  matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean;

  /**
   * Return a redacted copy of `record` suitable for inclusion in
   * `collect_bundle`. Per Q6, redaction policy is hardcoded in the bundle
   * module for MVP (header / query-param value masking, URL reconstruct);
   * profile-owned policy is a v2-G.1 candidate. The method exists on the
   * interface so the bundle pipeline can call it uniformly per source and so
   * Phase 4's concrete impl can carry source-specific masking nuances.
   */
  redactForBundle(record: ParsedRecord): ParsedRecord;

  /**
   * OPTIONAL — v0.4.0 Block A (audit findings 2026-05-26).
   *
   * Enforce the "no fetch-all" contract: agents calling `search_evidence`
   * MUST supply at least one filter field that actually narrows the result
   * set. Sources whose datasets can legitimately be small (no fetch-all
   * risk) leave this unset.
   *
   * Returning a string rejects the call with `query_underspecified`; the
   * string IS the user-facing message (caller wraps it as a typed error).
   * Returning `null` accepts the call.
   *
   * Time-windowed callers (`extract_evidence_context`) inject `tsMsRange`
   * before dispatch, so the source MAY accept presence of `tsMsRange` as
   * "narrowing enough" — `extract_*_context` calls remain frictionless.
   *
   * Convention: a negative-only filter (e.g. `excludeHeartbeat`) does NOT
   * count as narrowing; it reduces the result set but allows any positive
   * field to pour through.
   */
  validateNarrowingFilter?(query: EvidenceQuery): string | null;

  /**
   * OPTIONAL — Phase 4 amendment (codex audit R1).
   *
   * Decorate the agent's query with session-bound defaults before
   * `matchQuery` sees it. Called once per `searchEvidence` invocation
   * after dispatch + before iteration. Implementations are pure: they
   * may merge fields, raise floor values, or clamp ranges; they MUST
   * NOT touch I/O.
   *
   * Motivating case: `poppo_http`'s `http_*.jsonl` retention is up to 3
   * days / 100 MiB and a single file can contain multiple app process
   * runs (per the schema's "运行与文件" section). Without an implicit
   * lower bound, `search_evidence({source:"poppo_http"})` would leak
   * records from previous app runs into the current MCP session. So
   * `poppo_http.bindSession` raises `query.tsMsRange.from` to at least
   * `ctx.sessionStartMs`.
   *
   * If unset, runtime uses the agent's query verbatim.
   */
  bindSession?(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery;

  /**
   * OPTIONAL — v2-G.1 (codex 4-round plan review).
   *
   * Project `record` into an agent-facing preview shape — shrink oversize
   * fields (`body.text`, `body.decoded`, etc. for `poppo_http`) so a single
   * record cannot blow out the agent's context window. The hook fires at
   * `searchEvidence` page-slice time, AFTER `matchQuery` / `sortKey` /
   * cursor encoding / `recordsScanned` / `nextCursor` are decided (Q5b
   * invariants #1-#5) and AFTER the global `_meta` reservation invariant
   * has cleared (Q5b invariant #6). The runtime wraps the returned record
   * as `{ ...result.record, _meta: { preview: {...} } }` before emit.
   *
   * Pure: no I/O, no closures over external state.
   *
   * Sources without this hook fall through to raw passthrough; agents read
   * the absence of `_meta` on the response record as "this source does not
   * support preview" (see `preview-for-agent.md` § Q11 three-row table).
   * Agents may also opt out per-call via `fullRecords: true` on
   * `search_evidence` / `extract_evidence_context` — that path SKIPS this
   * hook entirely. Reserved-key invariant still fires either way.
   */
  previewForAgent?(record: ParsedRecord): PreviewResult;

  /**
   * OPTIONAL — Phase 4 amendment (codex audit R2).
   *
   * Return a lexicographically comparable key for `record`. When set,
   * the runtime collects every matched record, sorts the buffer by
   * lex-comparing per-record `sortKey()` outputs, then paginates via a
   * keyset cursor (cursor.ts `{kind:"sort"}` variant). When unset, the
   * runtime keeps its streaming file-then-line iteration (cursor.ts
   * `{kind:"stream"}` variant).
   *
   * The returned tuple MUST contain only `string | number` primitives —
   * cursor integrity validates the shape after a round-trip. Tuple
   * length should be stable across calls; runtime compares
   * element-by-element using JavaScript's standard `<` so types must
   * match position-by-position (don't mix string and number in the
   * same slot).
   *
   * # Stable + unique requirement (codex Phase 4 audit Q)
   *
   * Sortable sources MUST return a tuple that is UNIQUE per record
   * within any single `searchEvidence` call. The runtime's keyset
   * resume rule is `compareSortKeys(rec, cursor.sortKey) > 0` (strict
   * greater-than) — two records sharing the same sortKey on either
   * side of a page boundary would cause the later one to be silently
   * skipped. For `poppo_http`, `(tsMs, runId, seq)` satisfies this
   * because `(runId, seq)` is the schema's stable primary key.
   *
   * Motivating case: `poppo_http` returns `[record.tsMs, record.runId,
   * record.seq]` — matches the schema's reader contract
   * "sort by (tsMs, runId, seq)" (§ MCP 消费指南).
   *
   * Live append-only caveat: keyset pagination over append-only
   * evidence is not a snapshot — a record with `tsMs` below the last
   * page's cursor written between pages cannot be returned on a later
   * page. Snapshot consistency requires `stop_session` seal-pull
   * (Phase 5 `collect_bundle`) or a future explicit snapshot mode.
   */
  sortKey?(record: ParsedRecord): readonly (string | number)[];
}

/**
 * A loaded profile: the runtime bundle of evidence sources for one project.
 * Identity is `name`; content is whatever the built-in profile module
 * declares. v2-G MVP only carries `evidenceSources`; future profiles will
 * grow `sourceProfile` (v2-H source-mapping recipe) etc.
 */
export interface Profile {
  readonly name: string;
  readonly evidenceSources: readonly EvidenceSource[];
}
