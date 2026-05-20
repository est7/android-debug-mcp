import { createLogger } from "../mcp/log.ts";
import type { AppendStream } from "../store/jsonl.ts";
import { detectCrashSignature } from "./crash_marker.ts";
import { detectDropout } from "./dropout.ts";
import { DEFAULT_CRITICAL_TAGS, shouldKeep } from "./filter.ts";
import { LineBuffer } from "./line_buffer.ts";
import { type LogEntry, looksTruncated, parseThreadtimeLine } from "./parser.ts";
import type { ProcessTracker } from "./process_tracker.ts";
import type { RawWriter } from "./raw_writer.ts";

const log = createLogger("android-debug-mcp:logcat:worker");

/** Event payloads the worker hands back to the session for `events.jsonl`. */
export type LogcatWorkerEvent =
  | { readonly type: "abnormal_long_line"; readonly rawLineNo: number; readonly length: number }
  | {
      readonly type: "logd_dropped";
      readonly count: number;
      readonly reason: string;
      readonly rawLineNo: number;
    };

export interface LogcatWorkerDeps {
  readonly rawWriter: RawWriter;
  readonly logcatStream: AppendStream;
  readonly crashStream: AppendStream;
  readonly tracker: ProcessTracker;
  /** Sink for worker-emitted events (wired to `Session.appendEvent`). */
  readonly emitEvent: (event: LogcatWorkerEvent) => Promise<unknown>;
}

export interface LogcatStats {
  readonly bytesRead: number;
  readonly linesParsed: number;
  readonly crashMarkers: number;
  /** Count of swallowed derived-channel (jsonl / event) write failures. */
  readonly derivedErrors: number;
}

interface PendingEntry {
  readonly base: LogEntry;
  message: string;
  readonly rawLineNo: number;
  /**
   * Cumulative raw byte count through the END of this entry — its header line
   * plus any continuation lines merged in so far. Captured at entry creation
   * and extended per continuation, so the global counter advancing for the
   * NEXT header line cannot retro-shift this entry's offset (P4-R2-P2).
   */
  endByteCount: number;
  readonly buffer: string;
}

/**
 * The logcat ingestion pipeline (§ C-1 / § A).
 *
 * Dual-channel safety is the load-bearing invariant: the **raw** byte channel
 * must never be lost or truncated because the **derived** (jsonl) channel
 * failed. Two design rules enforce that:
 *
 *   1. `rawWriter.write(chunk)` runs *synchronously and unconditionally* at the
 *      top of `onChunk`, OUTSIDE the async promise chain — so a derived-side
 *      rejection can never skip the byte-tee for a later chunk.
 *   2. Every derived-side operation (jsonl append, event emit) is wrapped:
 *      failures are counted (`derivedErrors`) and swallowed, so the processing
 *      chain never stays rejected and `finish()` never rejects.
 *
 * Within those rules: decode (`TextDecoder`, non-fatal) → {@link LineBuffer} →
 * parse → merge stack continuations → filter → `logcat.jsonl`; the raw line is
 * also crash-scanned independently of the parser.
 */
export class LogcatWorker {
  private readonly lineBuffer = new LineBuffer();
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private processing: Promise<void> = Promise.resolve();

  private rawLineNo = 0;
  private rawByteCount = 0;
  private linesParsed = 0;
  private crashMarkers = 0;
  private derivedErrors = 0;
  private currentBuffer = "main";
  private pending: PendingEntry | null = null;

  constructor(private readonly deps: LogcatWorkerDeps) {}

  /**
   * Feed one raw stdout chunk. The raw byte-tee happens here, synchronously,
   * before anything async — it is NOT gated by the derived pipeline.
   */
  onChunk(chunk: Uint8Array): Promise<void> {
    // (1) Raw tee — synchronous, unconditional. The truth source advances even
    // if every derived write is failing.
    this.deps.rawWriter.write(chunk);
    // (2) Derived pipeline — chained for ordering, with an internal catch so a
    // rejection can never poison the chain for subsequent chunks.
    this.processing = this.processing
      .then(() => this.processDerived(chunk))
      .catch((err: unknown) => this.recordDerivedError(err));
    return this.processing;
  }

  /** Drain the line buffer + flush the open entry. Never rejects. */
  async finish(): Promise<void> {
    await this.processing;
    for (const line of this.lineBuffer.flush()) {
      await this.handleLine(line);
    }
    await this.flushPending();
  }

  stats(): LogcatStats {
    return {
      bytesRead: this.deps.rawWriter.bytesWritten,
      linesParsed: this.linesParsed,
      crashMarkers: this.crashMarkers,
      derivedErrors: this.derivedErrors,
    };
  }

  private async processDerived(chunk: Uint8Array): Promise<void> {
    const decoded = this.decoder.decode(chunk, { stream: true });
    const { lines, abnormalLongLines } = this.lineBuffer.push(decoded);
    for (let i = 0; i < abnormalLongLines; i++) {
      await this.emitSafely({
        type: "abnormal_long_line",
        rawLineNo: this.rawLineNo + 1,
        length: this.lineBuffer.pending,
      });
    }
    for (const line of lines) {
      await this.handleLine(line);
    }
  }

  /**
   * Process one raw line. The raw line counters advance UNCONDITIONALLY (so
   * `rawLineNo` never desyncs from the raw file), then the derived work runs
   * inside a try/catch — a jsonl/event failure on one line is counted and
   * swallowed, never aborting the rest of the chunk.
   */
  private async handleLine(line: string): Promise<void> {
    this.rawLineNo += 1;
    this.rawByteCount += Buffer.byteLength(line, "utf8") + 1; // +1 for the '\n'
    try {
      await this.deriveLine(line);
    } catch (err) {
      this.recordDerivedError(err);
    }
  }

  private async deriveLine(line: string): Promise<void> {
    // Crash scan runs on the RAW line — independent of the parser (§ C-1).
    const crash = detectCrashSignature(line);
    if (crash) {
      this.crashMarkers += 1;
      await this.deps.crashStream.append({
        rawLineNo: this.rawLineNo,
        type: crash.type,
        marker: crash.marker,
        line,
      });
    }

    const result = parseThreadtimeLine(line);
    switch (result.kind) {
      case "entry": {
        await this.flushPending();
        this.pending = {
          base: result.entry,
          message: result.entry.message,
          rawLineNo: this.rawLineNo,
          endByteCount: this.rawByteCount, // cumulative through this header line
          buffer: this.currentBuffer,
        };
        this.deps.tracker.observeSystemLine(result.entry);
        if (result.entry.tag === "chatty") {
          const drop = detectDropout(result.entry.message);
          if (drop) {
            await this.emitSafely({
              type: "logd_dropped",
              count: drop.count,
              reason: drop.reason,
              rawLineNo: this.rawLineNo,
            });
          }
        }
        break;
      }
      case "continuation":
      case "unparsed":
        if (this.pending !== null) {
          this.pending.message += `\n${result.text}`;
          // Extend the entry's raw span to cover this continuation line.
          this.pending.endByteCount = this.rawByteCount;
        }
        break;
      case "buffer_switch":
        this.currentBuffer = result.buffer;
        break;
      case "blank":
        break;
    }
  }

  private async flushPending(): Promise<void> {
    const entry = this.pending;
    if (entry === null) return;
    this.pending = null;
    this.linesParsed += 1;

    const merged: LogEntry = { ...entry.base, message: entry.message };
    if (
      !shouldKeep(merged, {
        appUid: this.deps.tracker.appUid,
        knownPids: this.deps.tracker.knownPids,
        criticalTags: DEFAULT_CRITICAL_TAGS,
      })
    ) {
      return;
    }
    try {
      await this.deps.logcatStream.append({
        tsRaw: merged.tsRaw,
        rawLineNo: entry.rawLineNo,
        rawByteCount: entry.endByteCount,
        buffer: entry.buffer,
        uid: merged.uid,
        pid: merged.pid,
        tid: merged.tid,
        level: merged.level,
        tag: merged.tag,
        message: merged.message,
        ...(looksTruncated(merged.message) ? { truncatedSuspect: true } : {}),
      });
    } catch (err) {
      this.recordDerivedError(err);
    }
  }

  /** Emit a worker event; a failure is a derived-side fault — counted, swallowed. */
  private async emitSafely(event: LogcatWorkerEvent): Promise<void> {
    try {
      await this.deps.emitEvent(event);
    } catch (err) {
      this.recordDerivedError(err);
    }
  }

  private recordDerivedError(err: unknown): void {
    this.derivedErrors += 1;
    log.warn("derived-channel write failed (raw channel unaffected)", {
      error: String(err),
      derivedErrors: this.derivedErrors,
    });
  }
}
