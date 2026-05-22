import { type Metadata, readMetadata } from "../store/metadata.ts";
import { ProjectRootMissingError } from "./errors.ts";

/**
 * Require the source-tree root recorded for a run.
 *
 * Q5: the source root is taken *only* from `metadata.projectRoot` — the value
 * resolved and persisted at `start_session` (Phase 2.0) — never inferred from
 * `runRoot` or cwd at map time. A run started outside a git checkout has
 * `projectRoot: null`; this throws {@link ProjectRootMissingError} so the
 * caller surfaces a hard `project_root_missing` rather than mapping against
 * the wrong tree.
 */
export function requireProjectRoot(metadata: Pick<Metadata, "projectRoot">): string {
  if (metadata.projectRoot === null) {
    throw new ProjectRootMissingError();
  }
  return metadata.projectRoot;
}

/** {@link requireProjectRoot} for a run directory — reads `metadata.json` first. */
export async function requireRunProjectRoot(runDir: string): Promise<string> {
  return requireProjectRoot(await readMetadata(runDir));
}
