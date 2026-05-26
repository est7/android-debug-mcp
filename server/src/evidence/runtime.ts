import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ToolDomainError } from "../mcp/toolError.ts";
import type {
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../profile/types.ts";
import { compareSortKeys, decodeCursor, encodeCursor } from "./cursor.ts";
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

  // Phase 4 amendment (codex audit R1): source may decorate the agent's
  // query with session-bound defaults (e.g. poppo_http raises
  // `tsMsRange.from` to ctx.sessionStartMs to keep cross-run records from
  // leaking into the current MCP session). Pure call; runs before any
  // iteration so the bound query reaches every matchQuery.
  const effectiveQuery: EvidenceQuery = input.source.bindSession
    ? input.source.bindSession(input.parsedQuery, input.ctx)
    : input.parsedQuery;

  // Phase 4 amendment (codex audit R2): if the source declares a sortKey,
  // switch to collect-then-sort-then-keyset-paginate. Otherwise keep Phase
  // 3's streaming file/line cursor path.
  if (input.source.sortKey !== undefined) {
    return runSortPath(input, effectiveQuery, cache, pulls);
  }
  return runStreamPath(input, effectiveQuery, cache, pulls);
}

/** Phase 3 streaming path — basename → line order, file/lineOffset cursor. */
async function runStreamPath(
  input: SearchEvidenceInput,
  query: EvidenceQuery,
  cache: MtimeCache,
  pulls: readonly PullSummary[],
): Promise<SearchEvidenceResult> {
  const localFiles = sortedLocalFiles(cache);
  const decoded =
    input.cursor !== null
      ? decodeCursor(input.cursor, {
          runId: input.runId,
          sourceId: input.source.id,
          runDir: input.runDir,
          cache,
        })
      : null;
  if (decoded !== null && decoded.kind !== "stream") {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor kind '${decoded.kind}' does not match source '${input.source.id}' iteration mode (stream)`,
      {},
    );
  }

  const iter = await iterateLocal({
    source: input.source,
    parsedQuery: query,
    files: localFiles,
    limit: input.limit,
    resumeLocalPath: decoded?.localPath ?? null,
    resumeLineOffset: decoded?.cursor.lineOffset ?? 0,
  });

  const nextCursor =
    iter.next === null
      ? null
      : encodeCursor({
          kind: "stream",
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
 * Phase 4 sort path — collect every matching record from every local file,
 * sort by `source.sortKey()`, then keyset-paginate. See `cursor.ts` § "Live
 * append-only caveat" for the snapshot-consistency limit.
 */
async function runSortPath(
  input: SearchEvidenceInput,
  query: EvidenceQuery,
  cache: MtimeCache,
  pulls: readonly PullSummary[],
): Promise<SearchEvidenceResult> {
  const sortKey = input.source.sortKey;
  if (sortKey === undefined) {
    // Defensive — should never happen given the caller's branch.
    throw new Error("runSortPath called with sortKey undefined");
  }

  const decoded =
    input.cursor !== null
      ? decodeCursor(input.cursor, {
          runId: input.runId,
          sourceId: input.source.id,
          runDir: input.runDir,
          cache,
        })
      : null;
  if (decoded !== null && decoded.kind !== "sort") {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor kind '${decoded.kind}' does not match source '${input.source.id}' iteration mode (sort)`,
      {},
    );
  }
  const resumeAfter = decoded?.cursor.sortKey ?? null;

  const localFiles = sortedLocalFiles(cache);
  let filesScanned = 0;
  let recordsScanned = 0;
  const collected: ParsedRecord[] = [];
  for (const localPath of localFiles) {
    filesScanned++;
    const text = await readFile(localPath, "utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      recordsScanned++;
      const rec = input.source.parseLine(line);
      if (rec === null) continue;
      if (!input.source.matchQuery(rec, query)) continue;
      collected.push(rec);
    }
  }

  const sorted = collected
    .map((rec) => ({ rec, key: sortKey(rec) }))
    .sort((a, b) => compareSortKeys(a.key, b.key));

  // Resume past the cursor's key (strictly greater).
  let startIdx = 0;
  if (resumeAfter !== null) {
    while (startIdx < sorted.length) {
      const entry = sorted[startIdx];
      if (entry === undefined) break;
      if (compareSortKeys(entry.key, resumeAfter) > 0) break;
      startIdx++;
    }
  }

  const pageEnd = Math.min(sorted.length, startIdx + input.limit);
  const pageRecords = sorted.slice(startIdx, pageEnd).map((e) => e.rec);
  const lastInPage = pageEnd > startIdx ? sorted[pageEnd - 1] : undefined;
  const hasMore = pageEnd < sorted.length;

  const nextCursor =
    hasMore && lastInPage !== undefined
      ? encodeCursor({
          kind: "sort",
          runId: input.runId,
          source: input.source.id,
          sortKey: [...lastInPage.key],
        })
      : null;

  return {
    records: pageRecords,
    nextCursor,
    pulls,
    statsRun: {
      filesScanned,
      recordsScanned,
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
