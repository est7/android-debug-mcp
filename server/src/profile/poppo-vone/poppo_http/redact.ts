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
 * 2. **Query parameters** `_sign` / `_random` (Poppo's signature scheme)
 *    plus stable user/device identifiers observed in Poppo URLs:
 *    matching entries in `request.params` get `value` replaced with raw
 *    `"[REDACTED]"`.
 *
 * 3. **URL field** — the full `url` carries those same values inline.
 *    Reconstruct via WHATWG `URL` so scheme/port/path are preserved exactly;
 *    rewrite `.search` from the redacted pair-list using `URLSearchParams`
 *    (insertion-order preserved, duplicate keys preserved). The placeholder
 *    ends up URL-encoded (`%5BREDACTED%5D`) per codex Phase 4 audit #5 —
 *    keeps the redacted URL a valid URL.
 *
 * 4. **request.decoded** — recursively traversed; object keys matching the
 *    query-param sensitive-name set (`imei`, `oaid`, `smei_id`, `_uid`,
 *    `uuid`, `appsflyer_id`, etc.) have their value replaced wholesale.
 *
 * # What's NOT redacted
 *
 *   - request/response body `text`, `preview`
 *   - response `app` envelope
 *   - error type/message/phase
 */

export const SENSITIVE_HEADER_NAMES_LC = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "set-cookie2",
  "proxy-authorization",
]);

export const SENSITIVE_QUERY_NAMES_LC = new Set([
  "_sign",
  "_random",
  "_uid",
  "uid",
  "smei_id",
  "uuid",
  "device_id",
  "imei",
  "oaid",
  "idfa",
  "appsflyer_id",
]);

/** Raw placeholder used in header values. URL field uses the URL-encoded form. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

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
    if (SENSITIVE_QUERY_NAMES_LC.has(p.name.toLowerCase())) {
      return { ...p, value: REDACTED_PLACEHOLDER };
    }
    return p;
  });
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactDecodedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactDecodedValue(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SENSITIVE_QUERY_NAMES_LC.has(key.toLowerCase())
      ? REDACTED_PLACEHOLDER
      : redactDecodedValue(entry);
  }
  return out;
}

/**
 * Rebuild the URL with redacted sensitive query values. Uses WHATWG `URL` for
 * scheme/host/port/path and `URLSearchParams` for the search component — both
 * preserve insertion order and duplicate keys.
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
    if (SENSITIVE_QUERY_NAMES_LC.has(name.toLowerCase())) {
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
    decoded: redactDecodedValue(record.request.decoded),
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
