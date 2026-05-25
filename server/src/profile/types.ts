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
 * v2-G Phase 1 stub for `EvidenceSource`. Phase 2 will fill in the
 * collector / puller / parser / matcher / redactor surface; Phase 4 lands the
 * concrete `poppo_http` impl. Today it carries only an `id` so the registry
 * can ferry profile selection through the system without touching tool code.
 */
export interface EvidenceSource {
  /** Stable identifier; matches the `source` literal in `search_evidence`'s
   * discriminated-union query (Q4). MUST be unique within a profile and
   * across the agent-visible MCP surface. */
  readonly id: string;
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
