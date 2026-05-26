import { resolve, sep } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "../mcp/toolError.ts";
import type { MtimeCache } from "./mtimeCache.ts";
import { sourceEvidenceDir } from "./paths.ts";

/**
 * search_evidence / extract_evidence_context pagination cursor (Q9 + codex
 * amendment #2).
 *
 * # Threat model
 *
 * Cursors are agent-controlled bytes round-tripped between tool calls. A
 * cursor is OPAQUE to the agent and OPACITY ALONE IS NOT INTEGRITY: a hostile
 * or buggy agent can flip bits and resubmit. The runtime later resolves the
 * cursor's file reference to an OS path to open. Without validation the
 * resolved path becomes a local-file-read primitive across the host's
 * filesystem.
 *
 * # Defenses (all enforced on decode)
 *
 *   - `runId` matches the caller's runId  → blocks cross-run misuse.
 *   - `source` matches the caller's source.id  → blocks cross-source misuse.
 *   - `fileKey` is a basename  (regex `^[^/\\]+$` and no `..`).
 *   - Resolving `<sourceEvidenceDir(runDir, source)>/<fileKey>` stays inside
 *     `sourceEvidenceDir(runDir, source)`  → blocks symlink/escape.
 *   - The resolved local path appears in the mtime cache  → blocks any path
 *     the runtime did not itself produce by pulling.
 *
 * Any defense failure throws `ToolDomainError("invalid_cursor")` so the agent
 * sees a normal branchable result, not a protocol error.
 *
 * # Payload shape rationale
 *
 *   `mtimeMs` is intentionally NOT in the cursor. JSONL evidence files are
 *   append-only on device, so `lineOffset` remains valid as a file grows; the
 *   mtime-cache membership check below is the integrity invariant. If a
 *   future source needs append-non-monotonic semantics, add a per-source
 *   cursor extension rather than promoting mtime to a global cursor field.
 */

const CursorSchema = z
  .object({
    runId: z.string().min(1),
    source: z.string().min(1),
    /**
     * Basename of the local pulled file under
     * `<runDir>/evidence/<source>/`. The runtime resolves this through
     * `sourceEvidenceDir` + the mtime cache; never trust it raw.
     */
    fileKey: z.string().regex(/^[^/\\]+$/, "fileKey must be a basename"),
    lineOffset: z.number().int().nonnegative(),
  })
  .strict();

export type EvidenceCursor = z.output<typeof CursorSchema>;

export function encodeCursor(c: EvidenceCursor): string {
  CursorSchema.parse(c); // defense-in-depth: refuse to emit a cursor we would reject on decode
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64");
}

export interface CursorContext {
  readonly runId: string;
  readonly sourceId: string;
  readonly runDir: string;
  readonly cache: MtimeCache;
}

/**
 * Decode an agent-supplied cursor and validate every defense from the threat
 * model. Throws `ToolDomainError("invalid_cursor")` on any mismatch.
 *
 * Returns the validated `EvidenceCursor` plus the resolved absolute local
 * file path the caller should open. Resolving here avoids re-deriving the
 * path at the call site and ensures the path-escape check and the open path
 * cannot drift apart.
 */
export interface DecodedCursor {
  readonly cursor: EvidenceCursor;
  readonly localPath: string;
}

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

  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ToolDomainError("invalid_cursor", `cursor shape invalid: ${detail}`, {});
  }
  const cursor = parsed.data;

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

  // Path-escape: even though the regex rejects `/`, `\`, and embedded
  // separators, a literal `..` would still pass the regex (it has no `/`).
  // Resolve and require the result to live under sourceEvidenceDir. The
  // resolved-prefix check below catches `..` segments because the regex
  // separately rejects them (`/` or `\` not allowed) — `..` alone is a
  // legal basename on most filesystems but matches no pulled file, so the
  // mtime-cache lookup later rejects it. We still defense-in-depth check
  // the resolved-prefix here so any future regex loosening doesn't open a
  // new escape route.
  const dir = resolve(sourceEvidenceDir(ctx.runDir, ctx.sourceId));
  const localPath = resolve(dir, cursor.fileKey);
  if (localPath !== dir && !localPath.startsWith(`${dir}${sep}`)) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor fileKey resolves outside sourceEvidenceDir: '${cursor.fileKey}'`,
      {},
    );
  }

  // mtime cache membership: the runtime only ever opens files it itself
  // pulled and recorded in the cache. A cursor whose fileKey does not point
  // to a cached entry is either tampered or stale across a wiped runDir.
  const inCache = Object.values(ctx.cache).some((e) => resolve(e.localPath) === localPath);
  if (!inCache) {
    throw new ToolDomainError(
      "invalid_cursor",
      `cursor fileKey '${cursor.fileKey}' has no entry in the mtime cache`,
      {},
    );
  }

  return { cursor, localPath };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
