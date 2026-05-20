import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Byte-for-byte writer for `logcat.raw.txt` (§ C-1).
 *
 * This is the *truth source*: it receives the raw `Uint8Array` chunks straight
 * off `adb logcat`'s stdout, with zero decoding, before the parser ever runs.
 * A parser bug therefore cannot corrupt it.
 *
 * Durability: buffered writes are flushed (`write` + `fdatasync`) whenever
 * ~200 lines have accumulated OR 1 s has elapsed since the last flush —
 * whichever comes first — so an abrupt process death loses at most a small,
 * bounded tail.
 */

const FLUSH_EVERY_LINES = 200;
const FLUSH_INTERVAL_MS = 1_000;

export class RawWriter {
  private readonly pending: Uint8Array[] = [];
  private pendingLineCount = 0;
  private totalBytes = 0;
  private closed = false;
  private flushing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    public readonly path: string,
    private handle: FileHandle,
  ) {}

  static async open(path: string): Promise<RawWriter> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    const writer = new RawWriter(path, handle);
    writer.timer = setInterval(() => {
      void writer.flush();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive solely for the flush timer.
    writer.timer.unref?.();
    return writer;
  }

  /** Queue a raw stdout chunk. Triggers a flush once ~200 lines have built up. */
  write(chunk: Uint8Array): void {
    if (this.closed) throw new Error(`RawWriter(${this.path}) is closed.`);
    if (chunk.length === 0) return;
    this.pending.push(chunk);
    this.pendingLineCount += countNewlines(chunk);
    if (this.pendingLineCount >= FLUSH_EVERY_LINES) {
      void this.flush();
    }
  }

  /** Write all queued bytes and fdatasync. Serialized so flushes never interleave. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.doFlush());
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    this.pendingLineCount = 0;
    const buf = Buffer.concat(batch.map((c) => Buffer.from(c)));
    await this.handle.write(buf);
    await this.handle.sync();
    this.totalBytes += buf.length;
  }

  /** Flush any remainder, stop the timer, close the fd. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.handle.close();
  }

  /** Total bytes durably written so far. */
  get bytesWritten(): number {
    return this.totalBytes;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function countNewlines(chunk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0x0a) n++;
  }
  return n;
}
