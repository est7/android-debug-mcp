import { randomBytes } from "node:crypto";

/**
 * Run id format (design-lock § F): ISO 8601 timestamp with `:` replaced by `-`,
 * followed by `_`, followed by 4 alphanumeric chars (case-sensitive).
 *
 * Example: `2026-05-19T10-15-49.821Z_aB3k`
 *
 * Why `:` → `-`: keeps the runId usable as a file/dir name on all platforms
 * (Windows forbids `:`). Why 4 chars: gives 14M^4 ≈ 4B combinations for any
 * given second — more than enough to dedupe two starts within the same second
 * (test loops, rapid restart) while staying short enough to read.
 */
const RUN_ID_ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[A-Za-z0-9]{4}$/;

export function mintRunId(now: Date = new Date()): string {
  const isoSafe = now.toISOString().replace(/:/g, "-");
  return `${isoSafe}_${randomAlnum(4)}`;
}

export function isValidRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}

function randomAlnum(n: number): string {
  // randomBytes is cryptographically strong; we use modulo bias correction by
  // rejecting any byte >= floor(256 / alphabetLen) * alphabetLen.
  const alphabet = RUN_ID_ALNUM;
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < n) {
    const buf = randomBytes(n * 2);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const byte = buf[i] as number;
      if (byte < max) out += alphabet.charAt(byte % alphabet.length);
    }
  }
  return out;
}
