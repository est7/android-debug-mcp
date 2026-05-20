/**
 * Pure parser for `adb logcat -v uid -v threadtime` output.
 *
 * The server spawns logcat with `-v uid -v threadtime`. On API ≥ 30 each line
 * carries a uid column; older devices omit it. `parseThreadtimeLine` accepts
 * both shapes and never throws — an unrecognized line comes back as
 * `{kind:"unparsed"}` so the worker can decide what to do with it (a stack
 * continuation, a buffer marker, or noise).
 *
 * This module is pure: no clock, no IO. The worker stamps wall-clock ts and
 * merges continuation lines into the preceding entry's `message`.
 */

export type LogLevel = "V" | "D" | "I" | "W" | "E" | "F" | "S";

export interface LogEntry {
  /** Device-clock timestamp as printed by logcat: `MM-DD HH:MM:SS.mmm` (no year). */
  readonly tsRaw: string;
  /** uid column when present (`-v uid`); numeric string or a name like `u0_a123`. */
  readonly uid: string | null;
  readonly pid: number;
  readonly tid: number;
  readonly level: LogLevel;
  readonly tag: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly kind: "entry"; readonly entry: LogEntry }
  | { readonly kind: "continuation"; readonly text: string }
  | { readonly kind: "buffer_switch"; readonly buffer: string }
  | { readonly kind: "blank" }
  | { readonly kind: "unparsed"; readonly text: string };

/** § A·4 — a message at/over this length whose tail looks cut mid-token is flagged. */
export const TRUNCATION_LENGTH_THRESHOLD = 4000;

const LEVELS = new Set<LogLevel>(["V", "D", "I", "W", "E", "F", "S"]);

// `MM-DD HH:MM:SS.mmm  <uid>  PID  TID L TAG: message`  (uid present, -v uid)
const WITH_UID =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\S+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?):\s?(.*)$/;
// `MM-DD HH:MM:SS.mmm  PID  TID L TAG: message`  (no uid column)
const WITHOUT_UID =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?):\s?(.*)$/;
// `--------- beginning of main` / `crash` / `system` / `kernel`
const BUFFER_MARKER = /^-+\s*beginning of\s+(\w+)/;

export function parseThreadtimeLine(line: string): ParseResult {
  if (line.trim() === "") return { kind: "blank" };

  const marker = BUFFER_MARKER.exec(line);
  if (marker?.[1]) return { kind: "buffer_switch", buffer: marker[1] };

  // A leading-whitespace line is a wrapped stack frame / detail line; it
  // belongs to the preceding entry. `at `, `Caused by:`, `... N more` are the
  // common Java-stack continuations and may appear without indentation.
  if (/^\s/.test(line) || /^(at\s|Caused by:|\.\.\.\s\d+\smore)/.test(line)) {
    return { kind: "continuation", text: line };
  }

  const withUid = WITH_UID.exec(line);
  if (withUid) {
    return entryResult({
      tsRaw: withUid[1] as string,
      uid: withUid[2] as string,
      pid: withUid[3] as string,
      tid: withUid[4] as string,
      level: withUid[5] as string,
      tag: withUid[6] as string,
      message: withUid[7] as string,
    });
  }
  const noUid = WITHOUT_UID.exec(line);
  if (noUid) {
    return entryResult({
      tsRaw: noUid[1] as string,
      uid: null,
      pid: noUid[2] as string,
      tid: noUid[3] as string,
      level: noUid[4] as string,
      tag: noUid[5] as string,
      message: noUid[6] as string,
    });
  }
  return { kind: "unparsed", text: line };
}

/**
 * Heuristic: a `message` at/over {@link TRUNCATION_LENGTH_THRESHOLD} chars
 * whose final non-space char is not a "natural end" (closing bracket / sentence
 * punctuation) is likely cut by Android logd's per-line limit. § A·4.
 */
export function looksTruncated(message: string): boolean {
  if (message.length < TRUNCATION_LENGTH_THRESHOLD) return false;
  const tail = message.trimEnd().slice(-1);
  if (tail === "") return false;
  return !"})].!?\"'".includes(tail);
}

function entryResult(raw: {
  tsRaw: string;
  uid: string | null;
  pid: string;
  tid: string;
  level: string;
  tag: string;
  message: string;
}): ParseResult {
  const level = raw.level as LogLevel;
  if (!LEVELS.has(level)) return { kind: "unparsed", text: raw.message };
  return {
    kind: "entry",
    entry: {
      tsRaw: raw.tsRaw,
      uid: raw.uid,
      pid: Number.parseInt(raw.pid, 10),
      tid: Number.parseInt(raw.tid, 10),
      level,
      tag: raw.tag.trim(),
      message: raw.message,
    },
  };
}
