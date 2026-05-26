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
 */
export interface ParsedRecord {
  readonly source: string;
  readonly [key: string]: unknown;
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
