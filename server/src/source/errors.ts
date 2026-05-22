/**
 * Domain errors for v2-A chain M (UI-node → source mapping).
 *
 * Mirrors `adb/errors.ts`: each error carries a `code` whose string value also
 * lives in `mcp/toolError.ts`'s `TOOL_ERROR_CODES`. The `source/` layer stays
 * decoupled from `mcp/` — it owns its own `SourceErrorCode` union and the
 * `map_ui_node_to_source` tool (Phase 4) renders these into the `{isError}`
 * envelope, exactly as the register helper does for `AdbError`.
 */

export type SourceErrorCode = "rg_not_found" | "search_timed_out" | "project_root_missing";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

/** `rg` (ripgrep) could not be resolved on PATH or via `RG_PATH`. */
export class RgNotFoundError extends SourceError {
  constructor(searchedPaths: readonly string[]) {
    super(
      "rg_not_found",
      `ripgrep (rg) not found. Tried: ${searchedPaths.join(", ")}. Install ripgrep, or set RG_PATH to point at the binary.`,
    );
    this.name = "RgNotFoundError";
  }
}

/**
 * An `rg` invocation exceeded its time budget and was killed. The search is
 * abandoned whole — a timed-out search never returns partial candidates
 * (design lock § D, `map`'s failure table: "绝不返回 partial").
 */
export class SearchTimedOutError extends SourceError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      "search_timed_out",
      `Source search exceeded ${timeoutMs}ms and was aborted; no partial results are returned.`,
    );
    this.name = "SearchTimedOutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The run has no `projectRoot` recorded, so there is no source tree to map
 * into. Q5: the source root is never inferred from `runRoot` or cwd — a run
 * started outside a git checkout (and without an explicit `projectRoot`)
 * simply cannot be mapped, and that is a hard error, not a `none` result.
 */
export class ProjectRootMissingError extends SourceError {
  constructor() {
    super(
      "project_root_missing",
      "This run has no projectRoot recorded. Start the session inside a git checkout, or pass an explicit projectRoot to start_session, before mapping UI nodes to source.",
    );
    this.name = "ProjectRootMissingError";
  }
}
