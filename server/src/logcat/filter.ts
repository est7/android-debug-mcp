/**
 * Channel-B keep rule (§ C-2).
 *
 * `logcat.raw.txt` keeps everything (`*:V`, unfiltered — the truth source).
 * `logcat.jsonl` is the filtered, structured view: a line is kept when
 *
 *   uid == appUid  OR  pid ∈ knownPids  OR  tag ∈ criticalTags
 *
 * Structured-view tradeoff (codex-confirmed, Phase 4 audit): § C-2's restated
 * rule dropped the original design-lock § B-11 `severity ≥ W` clause. We follow
 * § C-2 literally, so an error-level *system* line (foreign uid, foreign pid,
 * non-critical tag) does NOT reach `logcat.jsonl`. This is acceptable because
 * `logcat.raw.txt` keeps every line (`*:V`, unfiltered — the truth source) and
 * `crash_marker` scans that raw stream regardless of this filter. The cost is
 * only that the *structured* view is app-scoped, not system-wide.
 */

import type { LogEntry } from "./parser.ts";

export interface FilterContext {
  /** App uid as a string (matches the uid column logcat prints), or null. */
  readonly appUid: string | null;
  /** Current + historical pids of the app, maintained by process_tracker. */
  readonly knownPids: ReadonlySet<number>;
  /** System tags always kept for cross-cutting diagnosis. */
  readonly criticalTags: ReadonlySet<string>;
}

/**
 * Default critical system tags — process lifecycle, crash reporting, ANR, and
 * the native-crash tombstone tags, so app crashes survive the jsonl filter
 * even on a line whose pid is not (yet) in `knownPids`.
 */
export const DEFAULT_CRITICAL_TAGS: ReadonlySet<string> = new Set([
  "ActivityManager",
  "ActivityTaskManager",
  "AndroidRuntime",
  "DEBUG",
  "libc",
  "tombstoned",
  "ANR",
  "WindowManager",
  "System.err",
  "art",
  "lowmemorykiller",
]);

export function shouldKeep(entry: LogEntry, ctx: FilterContext): boolean {
  if (entry.uid !== null && ctx.appUid !== null && entry.uid === ctx.appUid) {
    return true;
  }
  if (ctx.knownPids.has(entry.pid)) {
    return true;
  }
  return ctx.criticalTags.has(entry.tag);
}
