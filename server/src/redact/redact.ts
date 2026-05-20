/**
 * Redaction matcher — v1 baked-in assumption #4.
 *
 * Phase 3 scope (this file): object-key redaction for `mark_event` payloads
 * and (later) `commands.jsonl` entries. A key whose name case-insensitively
 * matches one of the six sensitive terms has its value replaced with the
 * `REDACTED` placeholder.
 *
 * Phase 5 will extend this module with the `input_text` length-preserving
 * heuristic (`***<len>`) and a 20+ case golden table. The six-term key set
 * itself is locked by design-lock baked-in #4 and is NOT a Phase-5 decision.
 */

/** design-lock baked-in #4: the six sensitive terms. */
export const REDACT_KEY_TERMS = [
  "authorization",
  "cookie",
  "token",
  "password",
  "otp",
  "verification",
] as const;

export const REDACTED = "***";

/** Max object depth we recurse into. Beyond this, the subtree is replaced
 * with a marker so a pathological / cyclic-ish payload cannot blow the stack
 * or the redaction time budget. § E-m3 pins this at 5. */
export const MAX_REDACT_DEPTH = 5;

const DEEP_MARKER = "[redact:max-depth]";

// Case-insensitive *substring* match. For a redaction matcher a false
// positive (over-redacting a benign `tokenCount`) is harmless noise, while a
// false negative is a leak — so we deliberately match broadly: `userPassword`,
// `access_token`, `X-Auth-Token`, `verificationCode` all hit, and so does
// `tokenizer` (accepted over-redaction). Phase 5 may narrow this if a real
// false-positive becomes painful, but never at the cost of a miss.
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_TERMS.some((term) => lower.includes(term));
}

/**
 * Return a redacted deep copy of `value`. Strings / numbers / booleans / null
 * pass through unchanged at this phase (Phase 5 adds string-content scanning).
 * Object entries whose key is sensitive have their value replaced with
 * {@link REDACTED}, recursively, up to {@link MAX_REDACT_DEPTH}.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return DEEP_MARKER;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return redactObject(value as Record<string, unknown>, depth);
  }
  return value;
}

/** Redact a plain object's sensitive keys. Exposed for callers that already
 * hold an object and want the same depth semantics as {@link redactValue}. */
export function redactObject(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > MAX_REDACT_DEPTH) return { redacted: DEEP_MARKER };
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(val, depth + 1);
    }
  }
  return out;
}
