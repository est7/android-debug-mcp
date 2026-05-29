/**
 * Redaction matcher — v1 baked-in assumption #4.
 *
 * Three layers, applied to `events.jsonl` / `commands.jsonl` records (NOT to
 * `logcat.jsonl` — decision #6):
 *
 *   1. Object-key redaction — a key whose name matches one of the six
 *      sensitive terms has its value fully replaced (`redactObject`).
 *   2. String-content redaction — embedded credentials inside a string value
 *      (`Authorization:` / `Cookie:` headers, `token=…` / `password=…` query
 *      or form pairs, bare JWTs) are blanked (`redactString`).
 *   3. The `input_text` heuristic — typed text that mentions a sensitive word
 *      is replaced with a length-preserving placeholder (`redactInputText`).
 *
 * Throughout, the bias is deliberate: a false positive (over-redaction) is
 * harmless noise; a false negative is a leak. Match broadly.
 */

/** design-lock baked-in #4: the six sensitive terms (object-key matching). */
export const REDACT_KEY_TERMS = [
  "authorization",
  "cookie",
  "token",
  "password",
  "otp",
  "verification",
] as const;

export const REDACTED = "***";

/** Max object depth we recurse into (§ E-m3). */
export const MAX_REDACT_DEPTH = 5;

const DEEP_MARKER = "[redact:max-depth]";

// ---- layer 1: object keys -------------------------------------------------

/**
 * Case-insensitive *substring* key match. `userPassword`, `access_token`,
 * `X-Auth-Token`, `verificationCode` all hit — and so does `tokenizer`
 * (accepted over-redaction). A miss would be a leak; over-redaction is noise.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEY_TERMS.some((term) => lower.includes(term));
}

// ---- layer 2: string content ---------------------------------------------

// `Authorization:` / `Cookie:` headers — the ENTIRE value is sensitive
// (a Digest credential, or a multi-cookie header, carries secret material
// past every comma / semicolon / quote). The value therefore runs all the way
// to the newline (P5-P1-1). A header embedded mid-string over-redacts the rest
// of that line — accepted, per the false-positive-is-noise bias; structured
// `{Authorization: …}` objects are still handled precisely by the key layer.
const HEADER_SECRET = /(authorization|cookie)("?\s*[:=]\s*)([^\n\r]*)/gi;

// `token`/`password`/`otp`/`verification` with a QUOTED value (`key="…"`,
// `key: "…"`, JSON `"key":"…"`). The value may contain spaces, so it runs to
// the matching close quote (P5-P1-2).
const KV_SECRET_QUOTED = /(token|password|otp|verification)("?\s*[:=]\s*)(["'])([^"'\n\r]*)\3/gi;

// `token`/`password`/`otp`/`verification` with an UNQUOTED value (URL query,
// form body). A single value token, stopped at the next separator; an optional
// `Bearer ` scheme prefix is kept.
const KV_SECRET_UNQUOTED =
  /(token|password|otp|verification)("?\s*[:=]\s*)(bearer\s+)?([^\s"'&;,}\]\n\r]+)/gi;

// Poppo HTTP logs often embed signed URLs in free-text logcat lines. These
// keys are stable user/device identifiers or request signatures, so they are
// redacted even when they do not use generic names like `token`.
const POPPO_STABLE_ID_UNQUOTED =
  /(^|[^\w])(_sign|_random|_uid|uid|smei_id|uuid|device_id|imei|oaid|idfa|appsflyer_id)("?\s*[:=]\s*"?)([^\s"'&;,}\]\n\r]+)/gi;

// A bare JSON Web Token: three base64url segments. `eyJ` is the base64 of `{"`,
// so a JWT is recognizable even with no surrounding key.
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{2,}/g;

/**
 * Blank credentials embedded inside a free-text string. Idempotent: running it
 * on already-redacted output is a no-op. The quoted KV pass runs before the
 * unquoted one so a `key="multi word"` value is consumed as a whole.
 */
export function redactString(s: string): string {
  return s
    .replace(HEADER_SECRET, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(
      KV_SECRET_QUOTED,
      (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}${quote}`,
    )
    .replace(
      KV_SECRET_UNQUOTED,
      (_m, name: string, sep: string, bearer: string | undefined) =>
        `${name}${sep}${bearer ?? ""}${REDACTED}`,
    )
    .replace(
      POPPO_STABLE_ID_UNQUOTED,
      (_m, prefix: string, name: string, sep: string) => `${prefix}${name}${sep}${REDACTED}`,
    )
    .replace(JWT, REDACTED);
}

// ---- layer 3: input_text heuristic ---------------------------------------

/** § design-lock 147: the `input_text` trigger terms (text content). */
const INPUT_TEXT_TRIGGER = /password|token|otp|verification/i;

export interface InputTextRedaction {
  /** true when the heuristic fired and `value` is a placeholder. */
  readonly redacted: boolean;
  /** Either the original text, or `***<originalLength>` when redacted. */
  readonly value: string;
}

/**
 * Heuristic redaction for the `input_text` tool. When the typed text mentions
 * a sensitive word, it is replaced by a length-preserving placeholder
 * `***<len>` so the run record shows *that* something was typed and how long
 * it was, without leaking the content.
 *
 * This is a backstop — the agent should pass `sensitive: true` explicitly for
 * a genuine secret (open decision #8); the heuristic only catches the case
 * where it forgot AND the text happens to name a sensitive concept.
 */
export function redactInputText(text: string): InputTextRedaction {
  if (INPUT_TEXT_TRIGGER.test(text)) {
    return { redacted: true, value: `${REDACTED}${text.length}` };
  }
  return { redacted: false, value: text };
}

// ---- recursive value redaction (layers 1 + 2) ----------------------------

/**
 * Return a redacted deep copy of `value`:
 *   - object → sensitive keys fully blanked, others recursed.
 *   - array  → each element recursed.
 *   - string → scanned for embedded credentials (`redactString`).
 *   - other  → returned unchanged.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return DEEP_MARKER;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return redactObject(value as Record<string, unknown>, depth);
  }
  return value;
}

/** Redact a plain object: sensitive keys fully blanked, others recursed. */
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
