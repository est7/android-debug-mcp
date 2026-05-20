import { createReadStream } from "node:fs";

export interface FileLine {
  /** Byte offset of the first byte of this line within the file. */
  readonly offset: number;
  /** The line content, without its trailing newline. */
  readonly text: string;
}

const NEWLINE = 0x0a;

/**
 * Stream a text file as `(offset, text)` line pairs starting at `startOffset`,
 * without loading the whole file — the evidence files (`logcat.jsonl`,
 * `logcat.raw.txt`) can be tens of MB.
 *
 * A trailing line with no newline is deliberately NOT yielded: it may be a
 * record still mid-write on a live run, so a caller resuming from the last
 * yielded line's end re-reads it once complete. A missing file yields nothing.
 */
export async function* readLinesFrom(
  path: string,
  startOffset = 0,
): AsyncGenerator<FileLine, void> {
  const stream = createReadStream(path, { start: startOffset });
  let pending: Buffer = Buffer.alloc(0);
  let offset = startOffset;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
      let nl = pending.indexOf(NEWLINE);
      while (nl !== -1) {
        yield { offset, text: pending.subarray(0, nl).toString("utf8") };
        offset += nl + 1;
        pending = pending.subarray(nl + 1);
        nl = pending.indexOf(NEWLINE);
      }
    }
  } catch (err) {
    // A missing file is normal (logcat never started on this run); anything
    // else is a real IO fault and propagates.
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
  }
}
