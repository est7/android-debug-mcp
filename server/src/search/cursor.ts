import { ToolDomainError } from "../mcp/toolError.ts";

/**
 * Opaque pagination cursor for `search_logs` (§ D-M12).
 *
 * The payload is the scan position into `logcat.jsonl`: `offset` is the byte
 * offset of the next unread line, `scanned` is how many jsonl lines have been
 * read across the paginated sequence so far (telemetry + sanity only). It is
 * base64-encoded so callers treat it as opaque and never hand-construct one.
 */
export interface SearchCursor {
  readonly offset: number;
  readonly scanned: number;
}

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

/**
 * Decode a cursor string. A malformed cursor is a caller error, not a server
 * bug — it surfaces as the `invalid_cursor` domain error the agent can branch
 * on (e.g. drop the cursor and restart the search).
 */
export function decodeCursor(raw: string): SearchCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new ToolDomainError("invalid_cursor", "The cursor is not a valid search_logs cursor.");
  }
  const offset = (parsed as { offset?: unknown } | null)?.offset;
  const scanned = (parsed as { scanned?: unknown } | null)?.scanned;
  if (
    typeof offset !== "number" ||
    typeof scanned !== "number" ||
    !Number.isInteger(offset) ||
    !Number.isInteger(scanned) ||
    offset < 0 ||
    scanned < 0
  ) {
    throw new ToolDomainError("invalid_cursor", "The cursor is not a valid search_logs cursor.");
  }
  return { offset, scanned };
}
