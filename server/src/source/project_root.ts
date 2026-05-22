import { readMetadata } from "../store/metadata.ts";
import { ProjectRootMissingError } from "./errors.ts";

/**
 * Resolve the source-tree root a run maps UI nodes into, reading the
 * `projectRoot` persisted in `metadata.json` at `start_session` (Phase 2.0).
 *
 * Q5: the source root is taken *only* from this recorded value — never
 * inferred from `runRoot` or cwd at map time. A run started outside a git
 * checkout has `projectRoot: null`; this throws {@link ProjectRootMissingError}
 * so the caller surfaces a hard `project_root_missing` rather than silently
 * mapping against the wrong tree.
 */
export async function requireRunProjectRoot(runDir: string): Promise<string> {
  const metadata = await readMetadata(runDir);
  if (metadata.projectRoot === null) {
    throw new ProjectRootMissingError();
  }
  return metadata.projectRoot;
}
