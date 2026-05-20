/**
 * Crash signature scanner (§ design-lock crash markers).
 *
 * Runs over the *raw* logcat stream (the truth source — § C-1), so a parser
 * bug can never hide a crash. A hit is recorded to `crash.jsonl` keyed by
 * `rawLineNo` (1-based line number in `logcat.raw.txt`), which is stable
 * because raw is append-only and not re-encoded.
 */

export type CrashType = "java" | "native" | "anr";

export interface CrashSignature {
  readonly type: CrashType;
  /** The substring that triggered the match (for the agent to eyeball). */
  readonly marker: string;
}

interface SignatureRule {
  readonly type: CrashType;
  readonly re: RegExp;
}

// Order matters only for reporting; a line matches at most one rule (first win).
const RULES: readonly SignatureRule[] = [
  { type: "java", re: /\bFATAL EXCEPTION\b/ },
  { type: "java", re: /\bAndroidRuntime\b.*\b(FATAL|Exception)\b/ },
  { type: "java", re: /^\s*Caused by:/ },
  { type: "native", re: /\*\*\* \*\*\* \*\*\*/ },
  { type: "native", re: /\bsignal\s+(\d+)\s+\(SIG[A-Z]+\)/ },
  { type: "anr", re: /\bANR in\b/ },
];

/**
 * Inspect a raw logcat line for a crash signature. ANR `Reason:` lines are
 * intentionally NOT a standalone trigger — `Reason:` is too generic; an ANR is
 * anchored on `ANR in`. Returns `null` for an ordinary line.
 */
export function detectCrashSignature(rawLine: string): CrashSignature | null {
  for (const rule of RULES) {
    const m = rule.re.exec(rawLine);
    if (m) {
      return { type: rule.type, marker: m[0].trim() };
    }
  }
  return null;
}
