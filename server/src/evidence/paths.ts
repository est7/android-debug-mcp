import { join } from "node:path";

/**
 * Run-folder layout for v2-G evidence pulling.
 *
 *     <runDir>/
 *       evidence/
 *         <sourceId>/
 *           <pulled files…>
 *           .mtime-cache.json
 *
 * Per-source namespacing keeps independent sources from colliding on
 * filenames (the only thing they share is the device's filesystem rules).
 * The hidden `.mtime-cache.json` lives alongside its data so a single
 * recursive copy / bundle archive captures both halves coherently.
 */

/** Top-level sub-folder under `<runDir>` that hosts every source's pulled files. */
export const EVIDENCE_SUBDIR = "evidence";

/** Cache filename. Hidden so a casual `ls evidence/<source>/` shows data only. */
export const MTIME_CACHE_FILENAME = ".mtime-cache.json";

/** `<runDir>/evidence/<sourceId>/` — the per-source root. */
export function sourceEvidenceDir(runDir: string, sourceId: string): string {
  return join(runDir, EVIDENCE_SUBDIR, sourceId);
}

/** `<runDir>/evidence/<sourceId>/.mtime-cache.json`. */
export function mtimeCachePath(runDir: string, sourceId: string): string {
  return join(sourceEvidenceDir(runDir, sourceId), MTIME_CACHE_FILENAME);
}
