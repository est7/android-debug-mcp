import { type FileHandle, open } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Hard ceiling for a single JSONL line, in bytes. Phase 5 redaction is the
 * upstream backstop for log messages; this cap is a per-stream invariant so a
 * future bug elsewhere cannot push a multi-MB record through us silently. */
export const MAX_LINE_BYTES = 64 * 1024;

export class JsonlClosedError extends Error {
  constructor(path: string) {
    super(`AppendStream(${path}) has been closed; further writes are not allowed.`);
    this.name = "JsonlClosedError";
  }
}

export class JsonlEncodeError extends Error {
  constructor(path: string, cause: unknown) {
    super(`AppendStream(${path}) failed to JSON-encode payload: ${describeCause(cause)}`);
    this.name = "JsonlEncodeError";
  }
}

/**
 * Thrown when the caller hands us a value that `JSON.stringify` legally
 * returns `undefined` for (top-level `undefined`, functions, symbols). The old
 * template-literal code path silently coerced that to the literal string
 * `"undefined"` and wrote it as a "line" — a JSONL poison pill that breaks
 * every downstream replay / search consumer.
 */
export class JsonlInvalidRecordError extends Error {
  readonly recordType: string;
  constructor(path: string, recordType: string) {
    super(
      `AppendStream(${path}) refused a top-level ${recordType} record (JSON.stringify returned undefined).`,
    );
    this.name = "JsonlInvalidRecordError";
    this.recordType = recordType;
  }
}

export class JsonlLineTooLargeError extends Error {
  readonly byteLength: number;
  readonly maxBytes: number;
  constructor(path: string, byteLength: number, maxBytes: number) {
    super(`AppendStream(${path}) refused a ${byteLength}-byte line; cap is ${maxBytes} bytes.`);
    this.name = "JsonlLineTooLargeError";
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

export class JsonlWriteError extends Error {
  readonly bytesWritten: number;
  readonly expected: number;
  constructor(path: string, bytesWritten: number, expected: number) {
    super(`AppendStream(${path}) short write: wrote ${bytesWritten} of ${expected} bytes.`);
    this.name = "JsonlWriteError";
    this.bytesWritten = bytesWritten;
    this.expected = expected;
  }
}

/**
 * Single-writer append-only JSONL stream.
 *
 * Design choices:
 *   - Opened with `O_APPEND`. The kernel atomically positions each `write()`
 *     at the current EOF, so concurrent appenders (multiple processes pointing
 *     at the same file) cannot interleave bytes within a single `write()`
 *     call. POSIX does NOT promise that a multi-byte `write()` to a regular
 *     file is delivered as one underlying syscall (PIPE_BUF guarantees apply
 *     to pipes, not regular files), so we additionally:
 *       1. cap each line at {@link MAX_LINE_BYTES} so we stay well under any
 *          plausible page / cluster boundary, and
 *       2. assert `bytesWritten === buf.length` after the write and throw
 *          {@link JsonlWriteError} on a short write rather than silently
 *          continuing with a torn line.
 *   - `flush()` calls `FileHandle.sync()`, which maps to `fsync(2)` on POSIX
 *     (Node's `FileHandle.datasync()` is `fdatasync(2)`). For Phase 1's
 *     process-crash + raw-replay recovery this is sufficient; `F_FULLFSYNC`
 *     would buy power-loss durability at a large latency cost and is deferred.
 *   - `close()` flushes then closes the fd. Writes after `close()` throw
 *     {@link JsonlClosedError}.
 *
 * Caller responsibility: do not share an `AppendStream` across event loops /
 * workers; it is single-writer. For cross-process append, open a new
 * `AppendStream` per process — `O_APPEND` keeps that safe.
 */
export class AppendStream {
  private constructor(
    public readonly path: string,
    private handle: FileHandle,
    private closed = false,
  ) {}

  static async open(path: string): Promise<AppendStream> {
    await mkdir(dirname(path), { recursive: true });
    // 'a' = O_WRONLY | O_CREAT | O_APPEND.
    const handle = await open(path, "a");
    return new AppendStream(path, handle);
  }

  async append(record: unknown): Promise<void> {
    if (this.closed) throw new JsonlClosedError(this.path);
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(record);
    } catch (err) {
      // Circular refs / BigInt / throwing toJSON — surface to caller.
      throw new JsonlEncodeError(this.path, err);
    }
    if (encoded === undefined) {
      // JSON.stringify returns undefined for top-level `undefined`, functions,
      // and symbols. Without this guard the template literal below would write
      // the literal string "undefined" as a "line".
      throw new JsonlInvalidRecordError(this.path, describeRecordType(record));
    }
    const buf = Buffer.from(`${encoded}\n`, "utf8");
    if (buf.length > MAX_LINE_BYTES) {
      throw new JsonlLineTooLargeError(this.path, buf.length, MAX_LINE_BYTES);
    }
    const result = await this.handle.write(buf);
    if (result.bytesWritten !== buf.length) {
      throw new JsonlWriteError(this.path, result.bytesWritten, buf.length);
    }
  }

  async flush(): Promise<void> {
    if (this.closed) throw new JsonlClosedError(this.path);
    await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.handle.sync();
    } finally {
      this.closed = true;
      await this.handle.close();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function describeRecordType(record: unknown): string {
  if (record === undefined) return "undefined";
  if (record === null) return "null";
  const t = typeof record;
  if (t === "function") return "function";
  if (t === "symbol") return "symbol";
  return t;
}
