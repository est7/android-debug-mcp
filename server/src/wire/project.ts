import type { PoppoHttpRecord } from "../profile/poppo-vone/poppo_http/record.ts";

/**
 * Projection of one `http_*.jsonl` record into the wire recorder's shape (`method`/`path`/`query`/`headers`/
 * `fields`/`role`), the format `compare.ts` reads on its capture side. The rules follow the Vone debug recorder
 * (`AccountWireRecorder.project`), except that the decrypted payload comes from `request.decoded`, the form body
 * from `request.body.text`, and redaction happens here, at snapshot time:
 *
 *   - credentials, codes, tokens and device identifiers (by key name) become `<redacted>` (empty stays empty,
 *     because empty-versus-present is what the comparison looks at);
 *   - uid / phone / email values become stable per-snapshot aliases (`<uid:1>`, `<phone:1>`, `<email:1>`), so the
 *     same value maps to the same alias across requests.
 */

export type WireRole = "Current" | "Candidate" | "Anonymous" | "Untagged";
const ROLES: ReadonlySet<string> = new Set(["Current", "Candidate", "Anonymous", "Untagged"]);

export interface WireRecord {
  readonly method: string;
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
  readonly headers: readonly string[];
  readonly bodyMediaType: string;
  readonly encrypted: boolean;
  readonly fields: readonly (readonly [string, string])[];
  readonly role: WireRole | null;
  readonly time: number;
  readonly seq: number;
}

/** Parameters the app injects into every request; not the caller's business fields. */
const GLOBAL_KEYS: ReadonlySet<string> = new Set([
  "p",
  "smei_id",
  "device_name",
  "c",
  "v",
  "yidun_id",
  "sl",
  "l",
  "mcc",
  "vs",
  "uuid",
  "_mtime",
  "_random",
  "_sign",
  "b_vpn",
  "_uid",
  "_token",
]);

const DECODED_NOISE: ReadonlySet<string> = new Set(["_mtime", "b_vpn"]);

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "password",
  "new_pwd",
  "old_pwd",
  "ext_token",
  "appid",
  "country_number",
  "smei_id",
  "uuid",
  "yidun_id",
  "device_name",
  "login_device_id",
  "device_id",
  "imei",
  "oaid",
  "idfa",
  "appsflyer_id",
  "c_key",
  "vk_id_token",
]);

/** `token`, `code`, `sign`, … as a whole word of a snake_case key (`prev_sms_code`, `_sign`, `access_token`). */
const SECRET_WORD =
  /(^|_)(pass|passwd|password|pwd|token|secret|sign|random|code|captcha|ticket|validate|credential|cookie|authorization|otp|verify)(_|$)/;

const ALIAS_KIND: Readonly<Record<string, "uid" | "phone" | "email">> = {
  uid: "uid",
  _uid: "uid",
  userid: "uid",
  user_id: "uid",
  for_userid: "uid",
  phone: "phone",
  mobile: "phone",
  email: "email",
};

export const REDACTED = "<redacted>";
const MIN_ECHO_LENGTH = 6;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEYS.has(k) || SECRET_WORD.test(k);
}

/** Stable per-snapshot aliases: the n-th distinct value of a kind is `<kind:n>`. */
export class Aliaser {
  private readonly seen = new Map<string, Map<string, number>>();

  alias(kind: string, value: string): string {
    let values = this.seen.get(kind);
    if (values === undefined) {
      values = new Map();
      this.seen.set(kind, values);
    }
    let n = values.get(value);
    if (n === undefined) {
      n = values.size + 1;
      values.set(value, n);
    }
    return `<${kind}:${n}>`;
  }

  /**
   * The alias of a value already seen under an alias key, when it appears whole under another key (an id echoed as
   * `created_in_id`, say). Short values are ambiguous ("0", "1") and never matched this way.
   */
  lookup(value: string): string | null {
    if (value.length < MIN_ECHO_LENGTH) return null;
    for (const [kind, values] of this.seen) {
      const n = values.get(value);
      if (n !== undefined) return `<${kind}:${n}>`;
    }
    return null;
  }

  /** How many distinct values were aliased per kind (counts only). */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [kind, values] of this.seen) out[kind] = values.size;
    return out;
  }
}

/** The value of `key` as a snapshot may carry it. */
export function scrub(aliaser: Aliaser, key: string, value: string): string {
  if (value === "") return "";
  const kind = ALIAS_KIND[key.toLowerCase()];
  if (kind !== undefined) return aliaser.alias(kind, value);
  if (isSecretKey(key)) return REDACTED;
  return aliaser.lookup(value) ?? value;
}

function scrubDeep(aliaser: Aliaser, key: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubDeep(aliaser, key, v));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(aliaser, k, v);
    return out;
  }
  if (typeof value === "string") return scrub(aliaser, key, value);
  if (typeof value === "number" || typeof value === "boolean") {
    const scrubbed = scrub(aliaser, key, String(value));
    return scrubbed === String(value) ? value : scrubbed;
  }
  return value;
}

/** A decoded value as the recorder prints it: primitives plain, everything else as compact JSON. */
function decodedText(aliaser: Aliaser, key: string, value: unknown): string {
  if (typeof value === "string") return scrub(aliaser, key, value);
  if (typeof value === "number" || typeof value === "boolean")
    return scrub(aliaser, key, String(value));
  if (value === null || value === undefined) return "null";
  return JSON.stringify(scrubDeep(aliaser, key, value));
}

function formDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** `application/x-www-form-urlencoded` text as ordered pairs (duplicates and order kept). */
export function parseForm(text: string): [string, string][] {
  if (text === "") return [];
  return text.split("&").map((part) => {
    const eq = part.indexOf("=");
    return eq < 0
      ? ([formDecode(part), ""] as [string, string])
      : ([formDecode(part.slice(0, eq)), formDecode(part.slice(eq + 1))] as [string, string]);
  });
}

function isFormBody(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes("application/x-www-form-urlencoded") === true;
}

function ownerRole(record: PoppoHttpRecord): WireRole | null {
  const owner = (record.request as Record<string, unknown>).owner;
  if (typeof owner !== "object" || owner === null) return null;
  const role = (owner as Record<string, unknown>).role;
  return typeof role === "string" && ROLES.has(role) ? (role as WireRole) : null;
}

export interface ProjectionNotes {
  /** Encrypted requests whose `request.decoded` was missing: their fields are empty. */
  undecoded: number;
}

export function projectRecord(
  record: PoppoHttpRecord,
  aliaser: Aliaser,
  seq: number,
  notes: ProjectionNotes,
): WireRecord {
  const params = record.request.params.map((p) => [p.name, p.value] as const);
  const body = record.request.body;
  const form =
    record.method === "POST" && body.text !== null && isFormBody(body.contentType)
      ? parseForm(body.text)
      : [];
  const envelope = record.method === "POST" ? form : params;
  const encrypted = envelope.some(([k]) => k === "_sign");

  let fields: (readonly [string, string])[];
  const decoded = record.request.decoded;
  if (encrypted) {
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      fields = Object.entries(decoded as Record<string, unknown>)
        .filter(([k]) => !DECODED_NOISE.has(k))
        .map(([k, v]) => [k, decodedText(aliaser, k, v)] as const);
    } else {
      notes.undecoded++;
      fields = [];
    }
  } else {
    fields = envelope
      .filter(([k]) => !GLOBAL_KEYS.has(k))
      .map(([k, v]) => [k, scrub(aliaser, k, v)] as const);
  }
  // POST copies short body fields into the query; what is left besides globals came from the caller.
  if (record.method === "POST") {
    const bodyKeys = new Set(form.map(([k]) => k));
    for (const [k, v] of params) {
      if (!GLOBAL_KEYS.has(k) && !bodyKeys.has(k)) fields.push([k, scrub(aliaser, k, v)]);
    }
  }

  return {
    method: record.method,
    path: record.path,
    query: params.map(([k, v]) => [k, scrub(aliaser, k, v)] as const),
    headers: record.request.headers.map((h) => h.name),
    bodyMediaType: body.contentType ?? "",
    encrypted,
    fields: [...fields].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    role: ownerRole(record),
    time: record.tsMs,
    seq,
  };
}
