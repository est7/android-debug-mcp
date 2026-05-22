/**
 * `SourceCandidate` — one source location the recipe (Phase 2.1) attributes a
 * tapped UI node to. The `kind` taxonomy is the *stable contract* the Phase 3
 * confidence model is built on: it must not change shape after this phase
 * (plan § 2.2).
 */

/**
 * Why a candidate is interesting:
 *
 *   - `id_declaration` — the `@+id/<name>` declaration in a layout XML.
 *   - `screen_owner`   — the Activity / Fragment whose `BaseBinding…<XxxBinding>`
 *                        type parameter owns the layout the id is declared in.
 *   - `code_ref`       — a `binding.<camelName>` reference in Kotlin/Java.
 *   - `generated_noise`— a match that came from a generated location (a
 *                        `generated` path segment). Kept, but flagged so the
 *                        confidence model never treats it as a real code ref.
 *
 * `build/` is excluded at the search layer; `generated_noise` is the residual
 * net for generated code that lives outside `build/`.
 */
export const SOURCE_CANDIDATE_KINDS = [
  "id_declaration",
  "screen_owner",
  "code_ref",
  "generated_noise",
] as const;

export type SourceCandidateKind = (typeof SOURCE_CANDIDATE_KINDS)[number];

export interface SourceCandidate {
  /** Path relative to the run's `projectRoot`, POSIX separators, no `./` prefix. */
  readonly file: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** Classification — see {@link SOURCE_CANDIDATE_KINDS}. */
  readonly kind: SourceCandidateKind;
  /** The matched source line, trimmed. Always source code — never runtime/user text. */
  readonly text: string;
}

/**
 * Deterministic ordering rank per kind. Candidates are sorted
 * `(kindRank, file, line)` so a given (resourceId, projectRoot) always yields
 * an identically-ordered list (design lock: candidates are "确定性排序").
 */
export const SOURCE_CANDIDATE_KIND_RANK: Record<SourceCandidateKind, number> = {
  id_declaration: 0,
  screen_owner: 1,
  code_ref: 2,
  generated_noise: 3,
};
