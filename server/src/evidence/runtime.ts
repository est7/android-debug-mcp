import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../profile/types.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
  type MtimeCache,
  readMtimeCache,
  sourceEvidenceDir,
  writeMtimeCache,
} from "./mtimeCache.ts";

/**
 * v2-G Phase 3 lazy-pull orchestration (Q5+/Q9).
 *
 * `searchEvidence` is the single entry for both `search_evidence` (lazy
 * trigger) and `extract_evidence_context` (lazy trigger inside the marker
 * window — the tool handler decorates the query with `tsMsRange` before
 * calling). Mode-specific behaviour goes through `mode`:
 *
 *   - `mode="lazy"`     (default): pull only files where mtime changed.
 *     Emits `trigger:"lazy"` in {@link PullSummary}.
 *   - `mode="seal"`     : pull every device-listed file regardless of cache,
 *     bypassing the mtime equality skip. Used by `stop_session` so the
 *     final bundle never contains a stale tail of an active log.
 *
 * Function shape:
 *   - Pure on top of injected I/O surfaces (`source.listDeviceFiles`,
 *     `source.pullFile`, the mtime cache helpers, `node:fs/promises`).
 *   - Does NOT write `events.jsonl` / `commands.jsonl`. Returns the
 *     `PullSummary[]` + `RunStats` so the tool handler decides what to log
 *     (Q9 audit shape lives at the handler boundary).
 *
 * # Iteration order
 *
 *   Local files are iterated by basename ascending. For sources whose
 *   filename embeds a local date (poppo_http) this is roughly
 *   chronological; for sources that don't, basename order is at least
 *   deterministic which is what `cursor` integrity needs. Within a file,
 *   lines are iterated in file order; `lineOffset` in the cursor is the
 *   1-based-or-0-based — see {@link iterateLocal} — index into the
 *   split-by-`\n` array.
 */

export type EvidenceRuntimeMode = "lazy" | "seal";

export interface SearchEvidenceInput {
  readonly source: EvidenceSource;
  readonly parsedQuery: EvidenceQuery;
  readonly ctx: EvidenceContext;
  readonly runId: string;
  readonly runDir: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly mode?: EvidenceRuntimeMode;
}

export interface PullSummary {
  readonly devicePath: string;
  readonly localPath: string;
  readonly mtimeMs: number;
  /** Why this pull happened — feeds `events.jsonl evidence_pulled.trigger`. */
  readonly trigger: EvidenceRuntimeMode;
}

export interface RunStats {
  readonly filesScanned: number;
  readonly recordsScanned: number;
  readonly pullsTriggered: number;
  readonly pulledFiles: readonly string[];
}

export interface SearchEvidenceResult {
  readonly records: readonly ParsedRecord[];
  readonly nextCursor: string | null;
  readonly pulls: readonly PullSummary[];
  readonly statsRun: RunStats;
}

export async function searchEvidence(input: SearchEvidenceInput): Promise<SearchEvidenceResult> {
  const mode: EvidenceRuntimeMode = input.mode ?? "lazy";

  const cache = await readMtimeCache(input.runDir, input.source.id);
  const pulls = await syncDevicePulls(input, cache, mode);
  if (pulls.length > 0) {
    await writeMtimeCache(input.runDir, input.source.id, cache);
  }

  const localFiles = sortedLocalFiles(cache);
  const cursorState =
    input.cursor !== null
      ? decodeCursor(input.cursor, {
          runId: input.runId,
          sourceId: input.source.id,
          runDir: input.runDir,
          cache,
        })
      : null;

  const iter = await iterateLocal({
    source: input.source,
    parsedQuery: input.parsedQuery,
    files: localFiles,
    limit: input.limit,
    resumeLocalPath: cursorState?.localPath ?? null,
    resumeLineOffset: cursorState?.cursor.lineOffset ?? 0,
  });

  const nextCursor =
    iter.next === null
      ? null
      : encodeCursor({
          runId: input.runId,
          source: input.source.id,
          fileKey: basename(iter.next.localPath),
          lineOffset: iter.next.lineOffset,
        });

  return {
    records: iter.records,
    nextCursor,
    pulls,
    statsRun: {
      filesScanned: iter.filesScanned,
      recordsScanned: iter.recordsScanned,
      pullsTriggered: pulls.length,
      pulledFiles: pulls.map((p) => p.localPath),
    },
  };
}

/**
 * Pull-only entry for `stop_session` seal (codex amendment #1).
 *
 * `searchEvidence` couples pull + iterate + page + cursor — most of which
 * `stop_session` does not need. Seal only wants the bytes flushed locally so
 * the bundle assembled by `collect_bundle` (Phase 5) sees the active file's
 * tail. Post-session `search_evidence` is OUT of v2-G scope — the tool
 * requires an active session, so a closed run's evidence is reached via
 * `collect_bundle` only.
 *
 * Returns the {@link PullSummary} list so the caller can write
 * `events.jsonl evidence_pulled` with `trigger:"seal"`.
 *
 * Side effect: writes / updates the mtime cache to match the seal-pulled
 * mtimes. The cache outlives the session on disk; it is read by
 * `collect_bundle` to know which local files to include in the archive.
 */
export async function sealEvidenceSource(input: {
  readonly source: EvidenceSource;
  readonly ctx: EvidenceContext;
  readonly runDir: string;
}): Promise<readonly PullSummary[]> {
  const cache = await readMtimeCache(input.runDir, input.source.id);
  const fakeSearchInput: SearchEvidenceInput = {
    source: input.source,
    parsedQuery: { source: input.source.id } as EvidenceQuery,
    ctx: input.ctx,
    runId: "<seal>",
    runDir: input.runDir,
    limit: 1,
    cursor: null,
    mode: "seal",
  };
  const pulls = await syncDevicePulls(fakeSearchInput, cache, "seal");
  if (pulls.length > 0) {
    await writeMtimeCache(input.runDir, input.source.id, cache);
  }
  return pulls;
}

/**
 * Pull-diff against the mtime cache.
 *
 *   - lazy: pull when (no cache entry) OR (device mtime > cached mtime).
 *           Equal mtime = frozen file = skip.
 *   - seal: pull every listed file regardless of cache. The cache is still
 *           updated so a subsequent lazy call sees the seal-pulled mtime.
 *
 * Cache mutation is in-place; caller writes the result once after the loop
 * so a torn write can never leave a half-updated cache.
 */
async function syncDevicePulls(
  input: SearchEvidenceInput,
  cache: MtimeCache,
  mode: EvidenceRuntimeMode,
): Promise<readonly PullSummary[]> {
  const deviceFiles = await input.source.listDeviceFiles(input.ctx);
  const out: PullSummary[] = [];
  const dir = sourceEvidenceDir(input.runDir, input.source.id);
  for (const f of deviceFiles) {
    const cached = cache[f.path];
    const isFrozen = cached !== undefined && cached.mtimeMs >= f.mtimeMs;
    if (mode === "lazy" && isFrozen) continue;
    const localPath = join(dir, f.name);
    await input.source.pullFile(input.ctx, f, localPath);
    cache[f.path] = { mtimeMs: f.mtimeMs, localPath };
    out.push({ devicePath: f.path, localPath, mtimeMs: f.mtimeMs, trigger: mode });
  }
  return out;
}

interface IterateInput {
  readonly source: EvidenceSource;
  readonly parsedQuery: EvidenceQuery;
  readonly files: readonly string[];
  readonly limit: number;
  readonly resumeLocalPath: string | null;
  readonly resumeLineOffset: number;
}

interface IterateOutput {
  readonly records: readonly ParsedRecord[];
  readonly filesScanned: number;
  readonly recordsScanned: number;
  /** Where the next page would start; `null` when iteration completed. */
  readonly next: { readonly localPath: string; readonly lineOffset: number } | null;
}

async function iterateLocal(input: IterateInput): Promise<IterateOutput> {
  const records: ParsedRecord[] = [];
  let filesScanned = 0;
  let recordsScanned = 0;
  let pastResume = input.resumeLocalPath === null;

  for (const localPath of input.files) {
    if (!pastResume) {
      if (localPath !== input.resumeLocalPath) continue;
      pastResume = true;
    }
    filesScanned++;
    const text = await readFile(localPath, "utf8");
    const lines = text.split("\n");
    const startLine = localPath === input.resumeLocalPath ? input.resumeLineOffset : 0;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line === "") continue;
      recordsScanned++;
      const rec = input.source.parseLine(line);
      if (rec === null) continue;
      if (!input.source.matchQuery(rec, input.parsedQuery)) continue;
      if (records.length >= input.limit) {
        return {
          records,
          filesScanned,
          recordsScanned,
          next: { localPath, lineOffset: i },
        };
      }
      records.push(rec);
    }
  }
  return { records, filesScanned, recordsScanned, next: null };
}

function sortedLocalFiles(cache: MtimeCache): readonly string[] {
  return Object.values(cache)
    .map((e) => e.localPath)
    .sort((a, b) => {
      const ba = basename(a);
      const bb = basename(b);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    });
}
