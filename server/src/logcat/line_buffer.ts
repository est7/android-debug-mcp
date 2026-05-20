/**
 * Strict line-buffered reader (§ A·1).
 *
 * `adb logcat`'s stdout arrives as arbitrary byte chunks; a single log line can
 * straddle a chunk boundary. `LineBuffer` accumulates decoded text and only
 * emits a line when it sees `\n` — it never splits on a chunk boundary.
 *
 * Safety valve: if the carry buffer reaches {@link MAX_LINE_BUFFER_CHARS}
 * without a newline, the run is force-emitted as one line and the call reports
 * `abnormalLongLines > 0` so the worker can write an `abnormal_long_line`
 * event. This bounds memory against a pathological no-newline stream.
 */

/** Force-emit threshold for a newline-less run. ~64K UTF-16 units. */
export const MAX_LINE_BUFFER_CHARS = 64 * 1024;

export interface PushResult {
  readonly lines: string[];
  /** Count of force-emitted over-length lines in this push. */
  readonly abnormalLongLines: number;
}

export class LineBuffer {
  private carry = "";

  /** Feed a decoded text chunk; returns the complete lines it produced. */
  push(chunk: string): PushResult {
    this.carry += chunk;
    const lines: string[] = [];
    let abnormalLongLines = 0;

    let nl = this.carry.indexOf("\n");
    while (nl !== -1) {
      lines.push(stripCr(this.carry.slice(0, nl)));
      this.carry = this.carry.slice(nl + 1);
      nl = this.carry.indexOf("\n");
    }

    if (this.carry.length >= MAX_LINE_BUFFER_CHARS) {
      lines.push(stripCr(this.carry));
      this.carry = "";
      abnormalLongLines += 1;
    }
    return { lines, abnormalLongLines };
  }

  /** Emit any buffered remainder (call once when the stream ends). */
  flush(): string[] {
    if (this.carry === "") return [];
    const last = stripCr(this.carry);
    this.carry = "";
    return [last];
  }

  /** Chars currently held without a terminating newline. */
  get pending(): number {
    return this.carry.length;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
