import { resolve, sep } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "../mcp/toolError.ts";
import type { MtimeCache } from "./mtimeCache.ts";
import { sourceEvidenceDir } from "./paths.ts";

/**
 * search_evidence / extract_evidence_context pagination cursor (Q9 + codex
 * Phase 3 audit #2 + Phase 4 audit R2).
 *
 * # Two variants
 *
 * Phase 3 shipped a single `{runId, source, fileKey, lineOffset}` shape for
 * sources that iterate device files in basename → line order. Phase 4 added
 * sortable sources (`EvidenceSource.sortKey`) where the runtime collects all
 * matched records, sorts them lex by `sortKey()`, and paginates via a
 * keyset cursor. The two flows use a `kind` discriminator:
 *
 *   - `kind:"stream"` — file/line pagination (Phase 3 default). Cursor
 *     identifies a basename + line offset in the per-source dir.
 *   - `kind:"sort"` — keyset pagination over a sorted record buffer
 *     (Phase 4, when source declares `sortKey?`). Cursor carries the last
 *     emitted `sortKey()` tuple; next page yields records whose `sortKey()`
 *     is lex-greater than the cursor's tuple.
 *
 * Generic `cursor.ts` owns both variants. Sources only contribute the
 * `sortKey()` function — they never decode or encode cursors themselves
 * (information hiding per codex's R2 design: "source declares ordering
 * data, but runtime still owns cursor integrity and pagination mechanics").
 *
 * # Threat model (both variants)
 *
 * Cursors are agent-controlled bytes round-tripped between tool calls. A
 * cursor is OPAQUE to the agent and OPACITY ALONE IS NOT INTEGRITY: a
 * hostile or buggy agent can flip bits and resubmit. Validation must happen
 * on every decode.
 *
 * Both variants share:
 *   - `runId` matches caller's runId  → blocks cross-run misuse.
 *   - `source` matches caller's source.id  → blocks cross-source misuse.
 *
 * Stream-specific defenses:
 *   - `fileKey` is a basename (regex `^[^/\\]+$`).
 *   - Resolving `<sourceEvidenceDir>/<fileKey>` stays inside
 *     `sourceEvidenceDir(runDir, source)` — blocks symlink/escape.
 *   - The resolved local path appears in the mtime cache — blocks any path
 *     the runtime did not itself produce by pulling.
 *
 * Sort-specific defenses:
 *   - `sortKey` is a non-empty tuple of `string | number` primitives only —
 *     no objects, no arrays-of-arrays, no `null`/`undefined`. The runtime
 *     lex-compares with `<`, so any non-primitive is structurally invalid.
 *   - Tuple length bounded by `MAX_SORT_KEY_LEN` to keep cursors small.
 *
 * Any defense failure throws `ToolDomainError("invalid_cursor")` so the
 * agent sees a normal branchable result, not a protocol error.
 *
 * # Live-evidence caveat (sort variant only)
 *
 * Keyset pagination over append-only evidence is NOT a snapshot. A record
 * with a `sortKey()` below the last page's cursor — but written after that
 * page was emitted — will not surface on subsequent pages. Snapshot
 * consistency is `stop_session` seal-pull's job (Phase 5
 * `collect_bundle`), not the live-search runtime's. The doc string on
 * `EvidenceSource.sortKey` makes this contract explicit.
 */

/** Max length for the `sortKey` tuple in the sort-variant cursor. */
const MAX_SORT_KEY_LEN = 16;

const StreamCursorSchema = z
  .object({
    kind: z.literal("stream"),
    runId: z.string().min(1),
    source: z.string().min(1),
    fileKey: z.string().regex(/^[^/\\]+$/, "fileKey must be a basename"),
    lineOffset: z.number().int().nonnegative(),
  })
  .strict();

const SortKeyElementSchema = z.union([z.string(), z.number()]);

const SortCursorSchema = z
  .object({
    kind: z.literal("sort"),
    runId: z.string().min(1),
    source: z.string().min(1),
    sortKey: z
      .array(SortKeyElementSchema)
      .min(1, "sortKey must be non-empty")
      .max(MAX_SORT_KEY_LEN, `sortKey must be <= ${MAX_SORT_KEY_LEN} elements`),
  })
  .strict();

const EvidenceCursorSchema = z.discriminatedUnion("kind", [StreamCursorSchema, SortCursorSchema]);

export type StreamCursor = z.output<typeof StreamCursorSchema>;
export type SortCursor = z.output<typeof SortCursorSchema>;
export type EvidenceCursor = z.output<typeof EvidenceCursorSchema>;

export function encodeCursor(c: EvidenceCursor): string {
  // Defense-in-depth: refuse to emit a cursor we would reject on decode.
  EvidenceCursorSchema.parse(c);
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64");
}

export interface CursorContext {
  readonly runId: string;
  readonly sourceId: string;
  readonly runDir: string;
  readonly cache: MtimeCache;
}

/**
 * Decoded-cursor return type, discriminated by the cursor's own `kind`.
 * Stream cursors also expose the resolved absolute `localPath` (computed
 * inside `decodeCursor` so the path-escape check and the file open cannot
 * drift apart).
 */
export type DecodedCursor =
  | {
      readonly kind: "stream";
      readonly cursor: StreamCursor;
      readonly localPath: string;
    }
  | {
      readonly kind: "sort";
      readonly cursor: SortCursor;
    };

export function decodeCursor(raw: string, ctx: CursorContext): DecodedCursor {
  let decoded: unknown;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    decoded = JSON.parse(json);
  } catch (err) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor is not decodable as base64 JSON: ${describe(err)}`,
      {},
    );
  }

  const parsed = EvidenceCursorSchema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ToolDomainError("invalid_cursor", `cursor shape invalid: ${detail}`, {});
  }
  const cursor = parsed.data;

  // Shared defenses
  if (cursor.runId !== ctx.runId) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor runId mismatch: cursor='${cursor.runId}', call='${ctx.runId}'`,
      {},
    );
  }
  if (cursor.source !== ctx.sourceId) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor source mismatch: cursor='${cursor.source}', call='${ctx.sourceId}'`,
      {},
    );
  }

  if (cursor.kind === "stream") {
    return decodeStream(cursor, ctx);
  }
  // kind === "sort" — no fs check; the runtime just needs the tuple back.
  return { kind: "sort", cursor };
}

function decodeStream(
  cursor: StreamCursor,
  ctx: CursorContext,
): { readonly kind: "stream"; readonly cursor: StreamCursor; readonly localPath: string } {
  // Path-escape defense. The regex rejects `/` / `\`, but bare `..` is a
  // legal basename on most filesystems and would resolve to the parent of
  // sourceEvidenceDir. The resolved-prefix check catches that — independent
  // of the regex, so a future regex loosening cannot open this hole.
  const dir = resolve(sourceEvidenceDir(ctx.runDir, ctx.sourceId));
  const localPath = resolve(dir, cursor.fileKey);
  if (localPath !== dir && !localPath.startsWith(`${dir}${sep}`)) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor fileKey resolves outside sourceEvidenceDir: '${cursor.fileKey}'`,
      {},
    );
  }

  // mtime-cache membership: the runtime only ever opens files it itself
  // pulled + recorded. A cursor whose fileKey does not point to a cached
  // entry is either tampered or stale across a wiped runDir.
  const inCache = Object.values(ctx.cache).some((e) => resolve(e.localPath) === localPath);
  if (!inCache) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor fileKey '${cursor.fileKey}' has no entry in the mtime cache`,
      {},
    );
  }

  return { kind: "stream", cursor, localPath };
}

/**
 * Strict lex comparator for two `sortKey` tuples (used by the sort-variant
 * runtime path). Returns negative when `a < b`, positive when `a > b`, 0 on
 * equality. Compares element-by-element; the first differing position
 * decides. Shorter tuples sort before longer ones with identical prefix.
 *
 * Element-type mismatch (string vs number at the same position) throws
 * `invalid_cursor` rather than silently coercing — the source's sortKey
 * contract requires stable element types per position.
 */
export function compareSortKeys(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] as string | number;
    const bi = b[i] as string | number;
    if (typeof ai !== typeof bi) {
      throw new ToolDomainError(
        "invalid_cursor",
        `sortKey element type mismatch at index ${i}: ${typeof ai} vs ${typeof bi}`,
        {},
      );
    }
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return a.length - b.length;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
