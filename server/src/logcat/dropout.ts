/**
 * logd dropout / elision detection (§ A·2).
 *
 * When logd's ring buffer is under pressure it elides lines and prints a
 * marker. `adb logcat`'s "chatty" output collapses repeated lines with
 * `expire N lines` / `identical N lines`; some builds also print an explicit
 * `--- N lines dropped ---`. Either way the agent must see "there is a gap
 * here", so the worker turns a detected dropout into a `logd_dropped` event.
 *
 * Pure: operates on an already-parsed entry's tag + message, or a raw line.
 */

export interface DropoutInfo {
  readonly count: number;
  /** `chatty-expire` | `chatty-identical` | `dropped`. */
  readonly reason: string;
}

const CHATTY_EXPIRE = /\bexpire\s+(\d+)\s+lines?\b/i;
const CHATTY_IDENTICAL = /\bidentical\s+(\d+)\s+lines?\b/i;
const EXPLICIT_DROP = /(\d+)\s+lines?\s+dropped/i;

/**
 * Inspect a log line (or a parsed entry's `message`) for a dropout marker.
 * Returns `null` when the line is ordinary.
 */
export function detectDropout(text: string): DropoutInfo | null {
  const expire = CHATTY_EXPIRE.exec(text);
  if (expire?.[1]) return { count: toCount(expire[1]), reason: "chatty-expire" };

  const identical = CHATTY_IDENTICAL.exec(text);
  if (identical?.[1]) return { count: toCount(identical[1]), reason: "chatty-identical" };

  const dropped = EXPLICIT_DROP.exec(text);
  if (dropped?.[1]) return { count: toCount(dropped[1]), reason: "dropped" };

  return null;
}

function toCount(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
