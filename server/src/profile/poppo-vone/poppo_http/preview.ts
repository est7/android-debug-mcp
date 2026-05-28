import type { ParsedRecord, PreviewResult } from "../../types.ts";
import type { PoppoHttpRecord } from "./record.ts";

/**
 * v2-G.1 Block B — agent-facing record preview for poppo_http records.
 *
 * Producer-side records can be huge: a single `lang.json` response captured
 * by `CustomHttpLoggingInterceptor` measures ~622 KB on real Poppo data
 * (≈ 155k tokens by OpenAI-style estimation). Default `search_evidence` /
 * `extract_evidence_context` runs records through this projection before
 * emitting; agents that want the raw record pay explicitly via
 * `fullRecords: true`.
 *
 * # Hotspot scope (lock § Q4)
 *
 * Two fields drive ~90% of record byte volume:
 *
 *   1. `body.text` — the response/request body as decoded text. Truncated
 *      when present AND its real-byte length exceeds `THRESHOLD_BODY_TEXT_BYTES`.
 *   2. `body.decoded` — the body parsed-as-JSON convenience object the
 *      producer sometimes attaches. Truncated when present AND its
 *      `JSON.stringify` size exceeds `THRESHOLD_BODY_DECODED_BYTES`.
 *
 * Both `request.body` and `response.body` go through the same rules — Poppo
 * sometimes pushes huge multipart uploads inbound, and i18n responses are
 * huge outbound. Other fields (`error`, `app`, `headers`, `params`, etc.)
 * are small and pass through unchanged.
 *
 * # Truncation form
 *
 *   - `body.text` → first 1024 chars + ` …<truncated N bytes>` suffix.
 *     `textBytes` keeps its original value so agents can compute compression.
 *   - `body.decoded` → `{ __truncated: true, headChars, fullBytes }`. Loses
 *     the JSON tree but keeps the head string for parse-error inspection.
 *
 * # `fullSizeBytes` calculation
 *
 * Raw `JSON.stringify(record)` UTF-8 byte length. Bun's `Buffer.byteLength`
 * is the cheapest measurement on V8/JavaScriptCore — single pass over the
 * string. For a 622 KB record this is sub-5ms on a warm JIT (Phase 4
 * acceptance to verify against real fixture).
 *
 * # Schema invariants this respects
 *
 * The producer record schema (rev4 `submodulepoppo/docs/projects/...`)
 * carries three body invariants enforced at parse time:
 *
 *   I1. `text != null` ⟺ `textBytes != null` ⟺ `omittedReason == null`
 *   I2. `preview != null` ⟹ `omittedReason == "oversize"`
 *   I3. `preview != null` ⟺ `previewBytes != null`
 *
 * This preview function MUST NOT break I1 — when we truncate `text`, both
 * `text` and `textBytes` stay non-null and `omittedReason` stays null. I2/I3
 * are about producer-side oversize markers (`preview`/`previewBytes`/
 * `omittedReason == "oversize"`), independent of agent-side preview.
 * Touching them would conflate two different "preview" concepts; we leave
 * them alone.
 */

const THRESHOLD_BODY_TEXT_BYTES = 2048;
const THRESHOLD_BODY_DECODED_BYTES = 2048;
const HEAD_CHAR_LIMIT = 1024;

interface PoppoBody {
  readonly contentType: string | null;
  readonly charset: string | null;
  readonly text: string | null;
  readonly textBytes: number | null;
  readonly omittedReason: string | null;
  readonly preview: string | null;
  readonly previewBytes: number | null;
  readonly [key: string]: unknown;
}

interface PoppoRequest {
  readonly headers: unknown;
  readonly params: unknown;
  readonly decoded: unknown;
  readonly body: PoppoBody;
  readonly [key: string]: unknown;
}

interface PoppoResponse {
  readonly status: number;
  readonly headers: unknown;
  readonly body: PoppoBody;
  readonly app: unknown;
  readonly [key: string]: unknown;
}

interface TruncatedDecodedMarker {
  readonly __truncated: true;
  readonly headChars: string;
  readonly fullBytes: number;
}

function truncateText(text: string, fullBytes: number): string {
  const head = text.slice(0, HEAD_CHAR_LIMIT);
  return `${head} …<truncated ${fullBytes} bytes>`;
}

function truncateDecoded(decoded: unknown): TruncatedDecodedMarker | unknown {
  const serialized = JSON.stringify(decoded);
  if (serialized === undefined) return decoded;
  const fullBytes = Buffer.byteLength(serialized, "utf8");
  if (fullBytes <= THRESHOLD_BODY_DECODED_BYTES) return decoded;
  return {
    __truncated: true,
    headChars: serialized.slice(0, HEAD_CHAR_LIMIT),
    fullBytes,
  } satisfies TruncatedDecodedMarker;
}

/**
 * Project one body. Returns the (possibly identical) body + the list of
 * dotted field paths it mutated, scoped by `pathPrefix` ("request.body" or
 * "response.body").
 */
function previewBody(
  body: PoppoBody,
  pathPrefix: "request.body" | "response.body",
): { readonly body: PoppoBody; readonly truncatedFields: readonly string[] } {
  const mutated: string[] = [];
  let next: PoppoBody = body;

  if (body.text !== null && body.textBytes !== null && body.textBytes > THRESHOLD_BODY_TEXT_BYTES) {
    next = { ...next, text: truncateText(body.text, body.textBytes) };
    mutated.push(`${pathPrefix}.text`);
  }

  return { body: next, truncatedFields: mutated };
}

/**
 * Project one request envelope. Currently scopes to `request.body` (text +
 * decoded) per Q4 — request `decoded` is rare in Poppo but possible (POST
 * with JSON content-type).
 */
function previewRequest(req: PoppoRequest): {
  readonly request: PoppoRequest;
  readonly truncatedFields: readonly string[];
} {
  const mutated: string[] = [];
  let next: PoppoRequest = req;

  const bodyResult = previewBody(req.body, "request.body");
  if (bodyResult.truncatedFields.length > 0) {
    next = { ...next, body: bodyResult.body };
    mutated.push(...bodyResult.truncatedFields);
  }

  if (req.decoded !== null && req.decoded !== undefined) {
    const decodedPreview = truncateDecoded(req.decoded);
    if (decodedPreview !== req.decoded) {
      next = { ...next, decoded: decodedPreview };
      mutated.push("request.decoded");
    }
  }

  return { request: next, truncatedFields: mutated };
}

/** Project one response envelope. Scopes to `response.body.text` +
 * `response.body.decoded` per Q4. */
function previewResponse(resp: PoppoResponse): {
  readonly response: PoppoResponse;
  readonly truncatedFields: readonly string[];
} {
  const mutated: string[] = [];
  let next: PoppoResponse = resp;

  const bodyResult = previewBody(resp.body, "response.body");
  if (bodyResult.truncatedFields.length > 0) {
    next = { ...next, body: bodyResult.body };
    mutated.push(...bodyResult.truncatedFields);
  }

  // `response.body.decoded` is the producer's optional JSON parse of the
  // wire body. Truncate when oversize; preserve when small or null.
  const decoded = resp.body.decoded as unknown;
  if (decoded !== null && decoded !== undefined) {
    const decodedPreview = truncateDecoded(decoded);
    if (decodedPreview !== decoded) {
      next = { ...next, body: { ...next.body, decoded: decodedPreview } };
      mutated.push("response.body.decoded");
    }
  }

  return { response: next, truncatedFields: mutated };
}

export function previewPoppoHttpRecord(record: ParsedRecord): PreviewResult {
  const r = record as PoppoHttpRecord;

  // `fullSizeBytes` is measured on the ORIGINAL record so agents can decide
  // whether to re-fetch with `fullRecords:true`. Bun's `Buffer.byteLength`
  // is single-pass utf8 length.
  const fullSizeBytes = Buffer.byteLength(JSON.stringify(r), "utf8");

  const truncatedFields: string[] = [];
  let next: PoppoHttpRecord = r;

  const reqResult = previewRequest(r.request as unknown as PoppoRequest);
  if (reqResult.truncatedFields.length > 0) {
    next = { ...next, request: reqResult.request as unknown as PoppoHttpRecord["request"] };
    truncatedFields.push(...reqResult.truncatedFields);
  }

  if (r.response !== null) {
    const respResult = previewResponse(r.response as unknown as PoppoResponse);
    if (respResult.truncatedFields.length > 0) {
      next = { ...next, response: respResult.response as unknown as PoppoHttpRecord["response"] };
      truncatedFields.push(...respResult.truncatedFields);
    }
  }

  return {
    record: next as unknown as ParsedRecord,
    truncated: truncatedFields.length > 0,
    fullSizeBytes,
    truncatedFields,
  };
}
