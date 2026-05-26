import type { PoppoHttpRecord } from "./record.ts";

/**
 * Q6 redaction policy for `poppo_http` records — hardcoded in this module
 * (per backlog: "policy hardcoded in bundle module (future amendment 下放
 * profile — v2-G.1 candidate)"). Returns a redacted COPY; never mutates
 * the input. Pure per Phase 3 `EvidenceSource.redactForBundle` contract.
 *
 * # What's redacted
 *
 * 1. **Headers** (both request AND response per codex Phase 4 audit Z):
 *    five sensitive names matched case-insensitive; matching entries get
 *    `value` replaced with the raw placeholder `"[REDACTED]"`. Header
 *    `name` is preserved (the fact that an Authorization header was sent
 *    is itself useful signal; only the secret value is sensitive).
 *
 * 2. **Query parameters** `_sign` and `_random` (Poppo's signature scheme):
 *    matching entries in `request.params` get `value` replaced with raw
 *    `"[REDACTED]"`.
 *
 * 3. **URL field** — the full `url` carries the same `_sign`/`_random`
 *    values inline. Reconstruct via WHATWG `URL` so scheme/port/path are
 *    preserved exactly; rewrite `.search` from the redacted pair-list
 *    using `URLSearchParams` (insertion-order preserved, duplicate keys
 *    preserved). The placeholder ends up URL-encoded (`%5BREDACTED%5D`)
 *    per codex Phase 4 audit #5 — keeps the redacted URL a valid URL.
 *
 * # What's NOT redacted (Q6: "其他全 raw")
 *
 *   - request/response body `text`, `preview`
 *   - request `decoded` (decrypted signature payload — may contain
 *     business secrets, but Q6 MVP leaves it)
 *   - response `app` envelope
 *   - error type/message/phase
 *
 * Expanding this list (esp. body text + decoded) is a Phase 5 / v2-G.1
 * decision — don't drift it here unilaterally.
 */

const SENSITIVE_HEADER_NAMES_LC = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "proxy-authorization",
]);

const SENSITIVE_QUERY_NAMES = new Set(["_sign", "_random"]);

/** Raw placeholder used in header values. URL field uses the URL-encoded form. */
const REDACTED_PLACEHOLDER = "[REDACTED]";

interface NameValue {
  readonly name: string;
  readonly value: string;
  readonly [key: string]: unknown;
}

function redactHeaders(headers: readonly NameValue[]): NameValue[] {
  return headers.map((h) => {
    if (SENSITIVE_HEADER_NAMES_LC.has(h.name.toLowerCase())) {
      return { ...h, value: REDACTED_PLACEHOLDER };
    }
    return h;
  });
}

function redactQueryParams(params: readonly NameValue[]): NameValue[] {
  return params.map((p) => {
    if (SENSITIVE_QUERY_NAMES.has(p.name)) {
      return { ...p, value: REDACTED_PLACEHOLDER };
    }
    return p;
  });
}

/**
 * Rebuild the URL with redacted `_sign`/`_random` query values. Uses
 * WHATWG `URL` for scheme/host/port/path and `URLSearchParams` for the
 * search component — both preserve insertion order and duplicate keys.
 *
 * If `url` is unparseable (shouldn't happen — the producer writes a full
 * URL — but the record's schema is `.passthrough()` so we treat it
 * defensively), the original `url` is returned unchanged.
 */
function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const search = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (SENSITIVE_QUERY_NAMES.has(name)) {
      search.append(name, REDACTED_PLACEHOLDER);
    } else {
      search.append(name, value);
    }
  }
  parsed.search = search.toString();
  return parsed.toString();
}

export function redactPoppoHttpRecord(record: PoppoHttpRecord): PoppoHttpRecord {
  const redactedRequest = {
    ...record.request,
    headers: redactHeaders(record.request.headers),
    params: redactQueryParams(record.request.params),
  };

  const redactedResponse =
    record.response === null
      ? null
      : {
          ...record.response,
          headers: redactHeaders(record.response.headers),
        };

  return {
    ...record,
    url: redactUrl(record.url),
    request: redactedRequest,
    response: redactedResponse,
  } as PoppoHttpRecord;
}
