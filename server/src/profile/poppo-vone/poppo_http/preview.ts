import type { ParsedRecord, PreviewOpts, PreviewResult } from "../../types.ts";
import { derivePoppoHttpOutcome } from "./match.ts";
import type { PoppoHttpRecord } from "./record.ts";
import { REDACTED_PLACEHOLDER, redactPoppoHttpRecord } from "./redact.ts";

const THRESHOLD_BODY_TEXT_BYTES = 2048;
const THRESHOLD_BODY_DECODED_BYTES = 2048;
const HEAD_CHAR_LIMIT = 1024;

const POPPO_HTTP_SECTIONS = [
  "request.headers",
  "request.params",
  "request.body",
  "request.decoded",
  "response.headers",
  "response.body",
] as const;

type PoppoHttpSection = (typeof POPPO_HTTP_SECTIONS)[number];

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

function previewBody(
  body: PoppoBody,
  pathPrefix: "request.body" | "response.body",
): { readonly body: PoppoBody; readonly truncatedFields: readonly string[] } {
  const truncatedFields: string[] = [];
  let next: PoppoBody = body;

  if (body.text !== null && body.textBytes !== null && body.textBytes > THRESHOLD_BODY_TEXT_BYTES) {
    next = { ...next, text: truncateText(body.text, body.textBytes) };
    truncatedFields.push(`${pathPrefix}.text`);
  }

  const decoded = body.decoded;
  if (decoded !== null && decoded !== undefined) {
    const decodedPreview = truncateDecoded(decoded);
    if (decodedPreview !== decoded) {
      next = { ...next, decoded: decodedPreview };
      truncatedFields.push(`${pathPrefix}.decoded`);
    }
  }

  return { body: next, truncatedFields };
}

function digestRecord(record: PoppoHttpRecord): ParsedRecord {
  const app = record.response?.app;
  return {
    source: "poppo_http",
    tsMs: record.tsMs,
    runId: record.runId,
    seq: record.seq,
    method: record.method,
    path: record.path,
    host: record.host,
    status: record.response?.status ?? null,
    durationMs: record.durationMs,
    outcome: derivePoppoHttpOutcome(record),
    heartBeat: record.heartBeat,
    app:
      app === null || app === undefined
        ? null
        : {
            ok: app.ok,
            code: app.code,
            message: app.message,
          },
  };
}

function hasBodyContent(body: PoppoBody): boolean {
  return body.text !== null || body.preview !== null || body.decoded !== undefined;
}

function isSection(section: string): section is PoppoHttpSection {
  return (POPPO_HTTP_SECTIONS as readonly string[]).includes(section);
}

function sectionValue(record: PoppoHttpRecord, section: PoppoHttpSection): unknown {
  switch (section) {
    case "request.headers":
      return record.request.headers;
    case "request.params":
      return record.request.params;
    case "request.body":
      return record.request.body;
    case "request.decoded":
      return record.request.decoded;
    case "response.headers":
      return record.response?.headers;
    case "response.body":
      return record.response?.body;
  }
}

function availableSections(record: PoppoHttpRecord): readonly PoppoHttpSection[] {
  const out: PoppoHttpSection[] = ["request.headers", "request.params"];
  if (hasBodyContent(record.request.body as PoppoBody)) out.push("request.body");
  if (record.request.decoded !== null) out.push("request.decoded");
  if (record.response !== null) {
    out.push("response.headers", "response.body");
  }
  return out;
}

function sectionSizes(
  record: PoppoHttpRecord,
  available: readonly PoppoHttpSection[],
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const section of available) {
    out[section] = Buffer.byteLength(JSON.stringify(sectionValue(record, section)), "utf8");
  }
  return out;
}

function withSection(
  record: ParsedRecord,
  section: PoppoHttpSection,
  value: unknown,
): ParsedRecord {
  switch (section) {
    case "request.headers":
      return { ...record, request: { ...(record.request as object | undefined), headers: value } };
    case "request.params":
      return { ...record, request: { ...(record.request as object | undefined), params: value } };
    case "request.body":
      return { ...record, request: { ...(record.request as object | undefined), body: value } };
    case "request.decoded":
      return { ...record, request: { ...(record.request as object | undefined), decoded: value } };
    case "response.headers":
      return {
        ...record,
        response: { ...(record.response as object | undefined), headers: value },
      };
    case "response.body":
      return { ...record, response: { ...(record.response as object | undefined), body: value } };
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sectionRedactedFields(raw: PoppoHttpRecord, redacted: PoppoHttpRecord): readonly string[] {
  const fields = new Set<string>();
  if (raw.url !== redacted.url) fields.add("url");
  if (!sameJson(raw.request.headers, redacted.request.headers)) fields.add("request.headers");
  if (!sameJson(raw.request.params, redacted.request.params)) fields.add("request.params");
  if (!sameJson(raw.request.decoded, redacted.request.decoded)) fields.add("request.decoded");
  if (raw.response !== null && redacted.response !== null) {
    if (!sameJson(raw.response.headers, redacted.response.headers)) {
      fields.add("response.headers");
    }
  }
  return [...fields];
}

function filterRedactedFields(
  fields: readonly string[],
  sections: readonly PoppoHttpSection[],
): readonly string[] {
  return fields.filter((field) =>
    sections.some((section) => field === section || field.startsWith(`${section}.`)),
  );
}

function projectBodySection(
  record: PoppoHttpRecord,
  section: "request.body" | "response.body",
): { readonly value: unknown; readonly truncatedFields: readonly string[] } {
  if (section === "request.body") {
    const result = previewBody(record.request.body as PoppoBody, section);
    return { value: result.body, truncatedFields: result.truncatedFields };
  }
  if (record.response === null) {
    return { value: undefined, truncatedFields: [] };
  }
  const result = previewBody(record.response.body as PoppoBody, section);
  return { value: result.body, truncatedFields: result.truncatedFields };
}

export function previewPoppoHttpRecord(
  record: ParsedRecord,
  opts: PreviewOpts = {},
): PreviewResult {
  const raw = record as PoppoHttpRecord;
  const fullSizeBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  const redacted = redactPoppoHttpRecord(raw);
  const available = availableSections(redacted);
  const sizes = sectionSizes(redacted, available);
  const allRedactedFields = sectionRedactedFields(raw, redacted);

  if (opts.fullRecords === true) {
    return {
      record: redacted as unknown as ParsedRecord,
      truncated: false,
      fullSizeBytes,
      truncatedFields: [],
      ...(allRedactedFields.length > 0 ? { redactedFields: allRedactedFields } : {}),
      available,
      sizes,
    };
  }

  const selected = new Set((opts.fields ?? []).filter(isSection));
  let out = digestRecord(redacted);
  const truncatedFields: string[] = [];

  for (const section of available) {
    if (!selected.has(section)) continue;
    if (section === "request.body" || section === "response.body") {
      const projected = projectBodySection(redacted, section);
      if (projected.value !== undefined) {
        out = withSection(out, section, projected.value);
        truncatedFields.push(...projected.truncatedFields);
      }
      continue;
    }
    out = withSection(out, section, sectionValue(redacted, section));
  }

  const redactedFields = filterRedactedFields(allRedactedFields, [...selected]);

  return {
    record: out,
    truncated: truncatedFields.length > 0,
    fullSizeBytes,
    truncatedFields,
    ...(redactedFields.length > 0 ? { redactedFields } : {}),
    available,
    sizes,
  };
}
