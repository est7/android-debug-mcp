/**
 * Request-parameter comparator: a faithful port of the Vone repo's
 * `tools/account-wire-diff/baseline_diff.py` (same normalization, grouping and statuses), so a candidate build's
 * account requests can be compared with a reference build's from inside the MCP server.
 *
 * Both sides are reduced to one normalized projection per request: method, path, encryption, the ordered query
 * with normalized values, device-header presence, the decoded business fields and the identity role. Requests are
 * grouped by `method path [type/login_type/use]`; inside a group the SETS of distinct projections are compared,
 * because retry / refresh counts legitimately differ between runs. A projection the capture sends more often than
 * the baseline did (and more than once) is DUPLICATE.
 *
 * Deliberate differences from the Python tool (all about the optional `role`, see {@link roleOf}):
 *   - a record whose `role` is `null` (snapshots made without `request.owner.role`) is accepted instead of
 *     failing; role is then compared only if every record on both sides has one.
 *
 * Everything else, including the order of the report and the grouping keys, is checked against the Python tool
 * by `tests/wire/crosscheck.test.ts`.
 */

export type Pair = readonly [string, string];

/** A request reduced to what the comparison looks at. Values are already normalized (no raw values). */
export interface Projection {
  readonly method: string;
  readonly path: string;
  readonly encrypted: boolean;
  readonly query: readonly Pair[];
  readonly deviceHeaders: boolean;
  readonly fields: readonly Pair[];
  readonly role: string | null;
}

export type GroupStatus = "MATCH" | "CHANGED" | "MISSING" | "EXTRA" | "DUPLICATE";

export interface RepeatedEntry {
  readonly times: number;
  readonly baselineTimes: number;
  readonly projection: Projection;
}

export interface GroupReport {
  readonly group: string;
  readonly status: GroupStatus;
  readonly repeated?: readonly RepeatedEntry[];
  readonly onlyBaseline?: readonly Projection[];
  readonly onlyCapture?: readonly Projection[];
  readonly projections?: readonly Projection[];
}

/** Input that cannot be read as a recording (the Python tool exits 2). */
export class MalformedWireInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedWireInputError";
  }
}

const ALIAS = /^<[a-z#:]+[0-9]*>$|^<redacted>$/;

/** Values that depend on build, locale, clock or device; only key presence and position are compared. */
export const VOLATILE: ReadonlySet<string> = new Set([
  "_mtime",
  "_random",
  "_sign",
  "_uid",
  "v",
  "vs",
  "sl",
  "l",
  "mcc",
  "smei_id",
  "uuid",
  "yidun_id",
  "device_name",
  "login_device_id",
]);

/** Credentials and identities; only empty-versus-present is compared. */
export const SENSITIVE: ReadonlySet<string> = new Set([
  "password",
  "new_pwd",
  "old_pwd",
  "code",
  "sms_code",
  "email_code",
  "prev_sms_code",
  "prev_email_code",
  "verify_code",
  "ext_token",
  "token",
  "_token",
  "appid",
  "phone",
  "email",
  "userid",
  "uid",
  "for_userid",
  "country_number",
  "validate",
  "ticket",
  "captcha_token",
]);

export const DEVICE_HEADERS: ReadonlySet<string> = new Set([
  "x-request-time",
  "x-request-device",
  "x-request-device-id",
  "x-request-agent",
  "x-request-imei",
  "x-device-info",
]);

export const DEFAULT_DISCRIMINATORS: readonly string[] = ["type", "login_type", "use"];

/** Legacy had no candidate owner: a candidate signs exactly like the current identity it will become. */
const ROLE: Readonly<Record<string, string>> = {
  Current: "Current",
  Candidate: "Current",
  Anonymous: "Anonymous",
  Untagged: "Anonymous",
};

export function normValue(key: string, value: string): string {
  if (VOLATILE.has(key)) return "*";
  if (value === "") return "";
  if (SENSITIVE.has(key) || ALIAS.test(value)) return "<r>";
  return value;
}

function normPairs(pairs: readonly Pair[]): Pair[] {
  return pairs.map(([k, v]) => [k, normValue(k, v)] as const);
}

/** Python's string order (by code point), which is what `sorted()` over str uses. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ra = ia.next();
    const rb = ib.next();
    if (ra.done === true) return rb.done === true ? 0 : -1;
    if (rb.done === true) return 1;
    const ca = (ra.value as string).codePointAt(0) as number;
    const cb = (rb.value as string).codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

function comparePairs(a: Pair, b: Pair): number {
  return compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]);
}

function sortedPairs(pairs: readonly Pair[]): Pair[] {
  return [...pairs].sort(comparePairs);
}

// A POST query is the injector's copy of the form body for server logs; legacy built the body from a HashMap, so
// its order was incidental. Only GET query order is compared.
function normQuery(method: string, pairs: readonly Pair[]): Pair[] {
  const query = normPairs(pairs);
  return method === "POST" ? sortedPairs(query) : query;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new MalformedWireInputError(`${what} must be a string`);
  return value;
}

function asPairs(value: unknown, what: string): Pair[] {
  if (!Array.isArray(value)) throw new MalformedWireInputError(`${what} must be a list of pairs`);
  return value.map((p) => {
    if (!Array.isArray(p) || p.length < 2)
      throw new MalformedWireInputError(`${what} holds a non-pair`);
    return [asString(p[0], `${what} key`), asString(p[1], `${what} value`)] as const;
  });
}

function asBool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new MalformedWireInputError(`${what} must be a boolean`);
  return value;
}

/**
 * Role of a record. `null`/absent means the producer could not say (a snapshot from a build that does not write
 * `request.owner.role`); the Python tool has no such case. An unknown string is malformed, as there.
 */
function roleOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const role = typeof value === "string" ? ROLE[value] : undefined;
  if (role === undefined)
    throw new MalformedWireInputError(`unknown identity role ${JSON.stringify(value)}`);
  return role;
}

/** Recorder output (and snapshots): `method`/`path`/`query`/`headers`/`fields`/`role`. */
export function fromCapture(record: unknown): Projection {
  if (!isObject(record)) throw new MalformedWireInputError("record is not an object");
  if ("recorderError" in record) {
    throw new MalformedWireInputError(
      `recorder failed on ${String(record.path)}: ${String(record.recorderError)}`,
    );
  }
  const method = asString(record.method, "method");
  const headers = record.headers;
  if (!Array.isArray(headers)) throw new MalformedWireInputError("headers must be a list");
  return {
    method,
    path: asString(record.path, "path"),
    encrypted: asBool(record.encrypted, "encrypted"),
    query: normQuery(method, asPairs(record.query, "query")),
    deviceHeaders: headers.some((h) => DEVICE_HEADERS.has(asString(h, "header").toLowerCase())),
    fields: sortedPairs(normPairs(asPairs(record.fields, "fields"))),
    role: roleOf(record.role),
  };
}

/**
 * A baseline recorded with the debug recorder has the capture format; the phase-0 recordings have the
 * `projection.wire` / `projection.decoded` format.
 */
export function fromBaseline(record: unknown): Projection {
  if (!isObject(record) || !("projection" in record)) return fromCapture(record);
  const p = record.projection;
  if (!isObject(p) || !isObject(p.wire) || !isObject(p.decoded)) {
    throw new MalformedWireInputError("projection must hold wire and decoded");
  }
  const wire = p.wire;
  const decoded = p.decoded;
  const method = asString(wire.method, "wire.method");
  const wireHeaders = wire.headers;
  if (!Array.isArray(wireHeaders)) throw new MalformedWireInputError("wire.headers must be a list");
  const identity = decoded.identity;
  if (!isObject(identity)) throw new MalformedWireInputError("decoded.identity must be an object");
  return {
    method,
    path: asString(wire.path, "wire.path"),
    encrypted: asBool(wire.encrypted, "wire.encrypted"),
    query: normQuery(method, asPairs(wire.query, "wire.query")),
    deviceHeaders: wireHeaders.some(
      (h) => Array.isArray(h) && DEVICE_HEADERS.has(asString(h[0], "header").toLowerCase()),
    ),
    fields: sortedPairs(normPairs(asPairs(decoded.fields, "decoded.fields"))),
    role: roleOf(identity.role),
  };
}

export function groupKey(
  projection: Projection,
  discriminators: readonly string[] = DEFAULT_DISCRIMINATORS,
): string {
  const fields = new Map<string, string>();
  for (const [k, v] of projection.fields) fields.set(k, v); // dict(): the last duplicate wins
  const disc = discriminators
    .filter((k) => fields.has(k))
    .map((k) => `${k}=${fields.get(k)}`)
    .join(",");
  return `${projection.method} ${projection.path} [${disc}]`;
}

/** `json.dumps(value, sort_keys=True)`: Python's separators and ASCII escapes, so identity and order agree. */
export function pyJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return pyString(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  const entries = Object.keys(value as object)
    .sort(compareStrings)
    .map((k) => `${pyString(k)}: ${pyJson((value as Json)[k])}`);
  return `{${entries.join(", ")}}`;
}

function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || (c >= 0x7f && c <= 0xffff)) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c > 0xffff) {
      const v = c - 0x10000;
      out += `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
    } else out += ch;
  }
  return `${out}"`;
}

/** group key → (serialized projection → times seen). */
export type Groups = Map<string, Map<string, number>>;

export function addToGroups(
  groups: Groups,
  projection: Projection,
  discriminators: readonly string[] = DEFAULT_DISCRIMINATORS,
): void {
  const key = groupKey(projection, discriminators);
  let counts = groups.get(key);
  if (counts === undefined) {
    counts = new Map();
    groups.set(key, counts);
  }
  const id = pyJson(projection);
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

function sortedKeys(...maps: ReadonlyMap<string, unknown>[]): string[] {
  const keys = new Set<string>();
  for (const m of maps) for (const k of m.keys()) keys.add(k);
  return [...keys].sort(compareStrings);
}

export function diffGroups(baseline: Groups, capture: Groups): GroupReport[] {
  const empty = new Map<string, number>();
  const report: GroupReport[] = [];
  for (const key of sortedKeys(baseline, capture)) {
    const oldCounts = baseline.get(key) ?? empty;
    const newCounts = capture.get(key) ?? empty;
    const oldSet = new Set(oldCounts.keys());
    const newSet = new Set(newCounts.keys());
    const repeated = [...newSet]
      .filter((p) => (newCounts.get(p) as number) > Math.max(1, oldCounts.get(p) ?? 0))
      .sort(compareStrings);
    const sameSets = oldSet.size === newSet.size && [...oldSet].every((p) => newSet.has(p));
    let status: GroupStatus;
    if (newSet.size === 0) status = "MISSING";
    else if (oldSet.size === 0) status = "EXTRA";
    else if (!sameSets) status = "CHANGED";
    else status = repeated.length > 0 ? "DUPLICATE" : "MATCH";

    const parse = (s: string) => JSON.parse(s) as Projection;
    const entry: {
      group: string;
      status: GroupStatus;
      repeated?: RepeatedEntry[];
      onlyBaseline?: Projection[];
      onlyCapture?: Projection[];
      projections?: Projection[];
    } = { group: key, status };
    if (status === "DUPLICATE") {
      entry.repeated = repeated.map((p) => ({
        times: newCounts.get(p) as number,
        baselineTimes: oldCounts.get(p) ?? 0,
        projection: parse(p),
      }));
    }
    if (status === "CHANGED") {
      entry.onlyBaseline = [...oldSet]
        .filter((p) => !newSet.has(p))
        .sort(compareStrings)
        .map(parse);
      entry.onlyCapture = [...newSet]
        .filter((p) => !oldSet.has(p))
        .sort(compareStrings)
        .map(parse);
    } else if (status !== "MATCH") {
      entry.projections = [...(oldSet.size > 0 ? oldSet : newSet)].sort(compareStrings).map(parse);
    }
    report.push(entry);
  }
  return report;
}

export interface CompareOptions {
  /** Paths to compare; empty / absent compares everything. */
  readonly only?: ReadonlySet<string>;
  /** Fields that split one path into groups; absent uses {@link DEFAULT_DISCRIMINATORS}. */
  readonly discriminators?: readonly string[];
}

/** Parse JSONL text (blank lines skipped); every record must be readable, as in the Python tool. */
export function parseProjections(
  texts: readonly string[],
  convert: (record: unknown) => Projection,
  only?: ReadonlySet<string>,
): Projection[] {
  const out: Projection[] = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new MalformedWireInputError("a line is not valid JSON");
      }
      const projection = convert(record);
      if (only !== undefined && only.size > 0 && !only.has(projection.path)) continue;
      out.push(projection);
    }
  }
  return out;
}

export interface Comparison {
  readonly groups: readonly GroupReport[];
  readonly counts: Record<GroupStatus, number>;
  /** False when some record had no role: role was then left out of the comparison on both sides. */
  readonly roleCompared: boolean;
}

export function compareProjections(
  baseline: readonly Projection[],
  capture: readonly Projection[],
  options: CompareOptions = {},
): Comparison {
  const roleCompared = [...baseline, ...capture].every((p) => p.role !== null);
  const fold = (projections: readonly Projection[]): Groups => {
    const groups: Groups = new Map();
    for (const p of projections) {
      addToGroups(groups, roleCompared ? p : { ...p, role: null }, options.discriminators);
    }
    return groups;
  };
  const groups = diffGroups(fold(baseline), fold(capture));
  return { groups, counts: countStatuses(groups), roleCompared };
}

/** Python `sum(e["status"] == s ...)` over the five statuses. */
export function countStatuses(report: readonly GroupReport[]): Record<GroupStatus, number> {
  const counts: Record<GroupStatus, number> = {
    MATCH: 0,
    CHANGED: 0,
    MISSING: 0,
    EXTRA: 0,
    DUPLICATE: 0,
  };
  for (const e of report) counts[e.status]++;
  return counts;
}
