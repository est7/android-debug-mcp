import { z } from "zod";

/**
 * Zod schema for the `http_*.jsonl` record format (rev4, draft).
 *
 * Canonical contract: `submodulepoppo/docs/projects/http-log-jsonl-schema.md`.
 *
 * # Strictness
 *
 * Schema § 兼容性规则 says: "consumer MUST ignore unknown fields"; producer
 * may grow optional fields without bumping `v`. So:
 *
 *   - Every object level uses `.passthrough()` — unknown keys pass through
 *     untouched. We never `.strict()` here.
 *   - `omittedReason` and `error.phase` are typed `z.string().nullable()` (NOT
 *     `z.enum(...)`) so a new producer-side value (e.g. a future
 *     `"client-prefetch"` for omittedReason) does not fail parse on the reader
 *     side. Consumers are expected to treat unknown enum values as opaque.
 *   - `v` is the ONE hard reject — schema says "consumer MUST reject unknown
 *     `v`", so anything other than the literal `1` is a parse failure.
 *
 * # The exclusive `response` ⊕ `error` invariant
 *
 * Schema § 顶层字段: "`response` 与 `error` **恰好一个非 null**". We model
 * each as `.nullable()` at the level of the field, then add a `.refine()` at
 * the top level that checks exactly-one-non-null. Pre-refine, both being null
 * or both being non-null is invalid.
 *
 * # `source` stamping
 *
 * The producer's records do NOT carry a `source` field. `parseLine` stamps
 * `source: "poppo_http"` after a successful parse so the record satisfies
 * Phase 3's `ParsedRecord` shape. Schema includes `source` so the resulting
 * type lines up with the rest of the system.
 */

const HEADER_OR_PARAM = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .passthrough();

/**
 * Body sub-schema. Three producer invariants from schema rev4 § "不变量" are
 * enforced here via `.superRefine` (codex Phase 4 audit V1):
 *
 *   I1. `text != null` ⟺ `textBytes != null` ⟺ `omittedReason == null`
 *       (a complete body has all three signals; an omitted body has none.)
 *   I2. `preview != null` ⟹ `omittedReason == "oversize"`
 *       (preview is reserved for the oversize path — necessary condition.)
 *   I3. `preview != null` ⟺ `previewBytes != null`
 *       (a preview without its byte count, or vice versa, is malformed.)
 *
 * `omittedReason` remains opaque `z.string().nullable()` (NOT enum) per
 * schema § 兼容性规则 — new producer values must pass through. The literal
 * `"oversize"` check in I2 is the producer-side anchor; a future producer
 * that violates it has shipped a contract bug.
 */
const BODY = z
  .object({
    contentType: z.string().nullable(),
    charset: z.string().nullable(),
    text: z.string().nullable(),
    textBytes: z.number().int().nullable(),
    omittedReason: z.string().nullable(),
    preview: z.string().nullable(),
    previewBytes: z.number().int().nullable(),
  })
  .passthrough()
  .superRefine((b, ctx) => {
    const textPresent = b.text !== null;
    const textBytesPresent = b.textBytes !== null;
    const omittedReasonAbsent = b.omittedReason === null;
    if (textPresent !== textBytesPresent || textPresent !== omittedReasonAbsent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "body invariant I1 violated: text/textBytes/omittedReason==null must agree (all three signal complete-body, or none do)",
        path: ["text"],
      });
    }
    if (b.preview !== null && b.omittedReason !== "oversize") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'body invariant I2 violated: preview != null requires omittedReason === "oversize"',
        path: ["preview"],
      });
    }
    if ((b.preview !== null) !== (b.previewBytes !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "body invariant I3 violated: preview and previewBytes must agree on null-ness",
        path: ["preview"],
      });
    }
  });

const REQUEST = z
  .object({
    headers: z.array(HEADER_OR_PARAM),
    params: z.array(HEADER_OR_PARAM),
    decoded: z.unknown(),
    body: BODY,
  })
  .passthrough();

const APP = z
  .object({
    status: z.string().nullable(),
    code: z.number().int().nullable(),
    errCode: z.string().nullable(),
    errMsg: z.string().nullable(),
    message: z.string().nullable(),
    ok: z.boolean().nullable(),
  })
  .passthrough();

const RESPONSE = z
  .object({
    status: z.number().int(),
    headers: z.array(HEADER_OR_PARAM),
    body: BODY,
    app: APP.nullable(),
  })
  .passthrough();

const ERROR = z
  .object({
    type: z.string(),
    message: z.string().nullable(),
    phase: z.string().nullable(),
  })
  .passthrough();

const POPPO_HTTP_RECORD_BASE = z
  .object({
    v: z.literal(1),
    runId: z.string(),
    seq: z.number().int(),
    pid: z.number().int(),
    tsMs: z.number().int(),
    durationMs: z.number().int(),
    method: z.string(),
    url: z.string(),
    path: z.string(),
    host: z.string(),
    protocol: z.string().nullable(),
    heartBeat: z.boolean(),
    request: REQUEST,
    response: RESPONSE.nullable(),
    error: ERROR.nullable(),
  })
  .passthrough();

/**
 * Top-level schema with the exclusive-or invariant on `response` / `error`.
 * A record passing this schema is guaranteed to have exactly one populated.
 */
export const PoppoHttpRecordSchema = POPPO_HTTP_RECORD_BASE.refine(
  (r) => (r.response === null) !== (r.error === null),
  {
    message: "exactly one of `response` and `error` must be non-null",
    path: ["response"],
  },
);

export type PoppoHttpRecord = z.output<typeof PoppoHttpRecordSchema> & {
  readonly source: "poppo_http";
};

/**
 * Validate `line` (one JSONL row) against the rev4 schema. Returns the
 * stamped record on success, `null` on any parse / validation failure. Never
 * throws — Phase 3 contract says parseLine MUST be exception-free
 * ("malformed JSON in an active file mid-write" is the active-file
 * half-line case the source iterates past).
 */
export function parsePoppoHttpLine(line: string): PoppoHttpRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const result = PoppoHttpRecordSchema.safeParse(raw);
  if (!result.success) return null;
  return { source: "poppo_http", ...result.data } as PoppoHttpRecord;
}
