import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { mtimeCachePath, sourceEvidenceDir } from "./paths.ts";

/**
 * Per-source mtime cache I/O for v2-G lazy pull (Q5+).
 *
 * Stored at `<runDir>/evidence/<sourceId>/.mtime-cache.json`. One entry per
 * device path the source has already pulled; on next search_evidence the
 * Phase 3 wiring stats each candidate file on the device and skips the pull
 * when the cached `mtimeMs` matches (active log files mutate, rolled files
 * are frozen).
 *
 * # Concurrency
 *
 * The MCP server is single-process per session, so multiple concurrent
 * `search_evidence` calls within one session race on the same cache file.
 * Phase 2 does NOT lock:
 *
 *   - Two parallel reads see the same mtime → both pull (idempotent: same
 *     file bytes overwritten twice).
 *   - Concurrent writes are tmp+rename atomic per-write, so the final cache
 *     state is whichever write committed last; no torn file is observable.
 *   - Net effect: a doubled pull, not a corruption. Acceptable for MVP.
 *
 * If parallel pull bandwidth becomes a real problem, add an in-process
 * Promise dedup at the Phase 3 tool layer — not here.
 */

const MtimeCacheEntrySchema = z
  .object({
    /** mtime in epoch ms, as recorded after a successful pull. */
    mtimeMs: z.number().int().nonnegative(),
    /** Absolute local path where the puller wrote the file. */
    localPath: z.string().min(1),
  })
  .strict();

const MtimeCacheFileSchema = z
  .object({
    version: z.literal(1),
    /** Keyed by absolute device path (e.g. `/sdcard/.../http_2026-05-26_0.jsonl`). */
    entries: z.record(z.string(), MtimeCacheEntrySchema),
  })
  .strict();

export type MtimeCacheEntry = z.output<typeof MtimeCacheEntrySchema>;

/** In-memory cache view. Plain object — caller mutates and round-trips via `write`. */
export type MtimeCache = Record<string, MtimeCacheEntry>;

/**
 * Read the per-source mtime cache. Returns an empty cache (not an error) when
 * the file does not yet exist — first-run lazy pull is the happy path.
 *
 * A malformed cache file throws: the rest of the evidence pipeline relies on
 * the cache being honest (a wrong mtime says "skip the pull" and silently
 * yields stale results). Better to surface the corruption now and let the
 * Phase 3 wiring decide whether to soft-empty or re-pull from scratch.
 */
export async function readMtimeCache(runDir: string, sourceId: string): Promise<MtimeCache> {
  const path = mtimeCachePath(runDir, sourceId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return {};
    throw new Error(`failed to read mtime cache at ${path}: ${describe(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`mtime cache at ${path} is not valid JSON: ${describe(err)}`);
  }
  const parsed = MtimeCacheFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`mtime cache at ${path} failed validation: ${detail}`);
  }
  return { ...parsed.data.entries };
}

/**
 * Write the per-source mtime cache atomically. Creates the source dir if it
 * does not exist (callers do not have to remember the mkdir before their
 * first pull).
 *
 * Atomicity is the same tmp+rename pattern as `store/metadata.ts`: a torn
 * write is never observable because `rename` is atomic on POSIX. The tmp
 * filename embeds pid+timestamp so two writers can't collide on tmp paths.
 */
export async function writeMtimeCache(
  runDir: string,
  sourceId: string,
  cache: MtimeCache,
): Promise<void> {
  const path = mtimeCachePath(runDir, sourceId);
  await mkdir(sourceEvidenceDir(runDir, sourceId), { recursive: true });
  const payload: z.input<typeof MtimeCacheFileSchema> = {
    version: 1,
    entries: cache,
  };
  // Re-validate before writing so a caller mutating the in-memory map with
  // garbage values can't smuggle past the schema. Cheap and centralizes the
  // shape contract here rather than at every call site.
  const validated = MtimeCacheFileSchema.parse(payload);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, { flag: "w" });
  await rename(tmp, path);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export path helpers so Phase 3 tool code can import paths + cache I/O
// from a single module without two import lines for the same domain.
export {
  mtimeCachePath,
  sourceEvidenceDir,
  EVIDENCE_SUBDIR,
  MTIME_CACHE_FILENAME,
} from "./paths.ts";
