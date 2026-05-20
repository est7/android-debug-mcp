import type { ChildProcess } from "node:child_process";
import { getAppUid } from "../adb/app.ts";
import { createLogger } from "../mcp/log.ts";
import type { LogcatState } from "../session/health.ts";
import type { EventInput } from "../session/session.ts";
import type { AppendStream } from "../store/jsonl.ts";
import { ProcessTracker } from "./process_tracker.ts";
import { RawWriter } from "./raw_writer.ts";
import { type LogcatBufferInfo, startLogcat } from "./spawn.ts";
import { LogcatWorker } from "./worker.ts";

const log = createLogger("android-debug-mcp:logcat");

/** Grace period for the adb child to exit after SIGTERM before SIGKILL (§ D-M1). */
const SHUTDOWN_GRACE_MS = 3_000;

export interface LogcatChannelInput {
  readonly deviceSerial: string;
  readonly packageName: string;
  readonly userId: number;
  readonly runDir: string;
  readonly startedAt: Date;
  readonly requestedBufferSize: string;
  readonly logcatStream: AppendStream;
  readonly crashStream: AppendStream;
  readonly emitEvent: (event: EventInput) => Promise<unknown>;
  readonly seedPids: readonly number[];
}

export interface LogcatShutdownInfo {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  /** true when the SIGKILL fallback had to be used. */
  readonly killed: boolean;
  readonly bytesRead: number;
  readonly linesParsed: number;
  /** Swallowed derived-channel (jsonl/event) write failures — raw was unaffected. */
  readonly derivedErrors: number;
  readonly bufferInfo: LogcatBufferInfo;
}

/**
 * Owns one session's logcat dual channel: the streaming `adb logcat` child,
 * the byte-tee {@link RawWriter}, the {@link LogcatWorker} pipeline, and the
 * {@link ProcessTracker}.
 *
 * Shutdown follows § D-M1: SIGTERM the child → wait (≤3 s) for its `close`
 * event → drain the worker → close the raw writer → SIGKILL fallback if still
 * alive. The raw writer is closed in a `finally`, so even a worker-drain
 * failure cannot lose already-buffered raw bytes (P4-P1-1).
 */
export class LogcatChannel {
  private state: LogcatState = "running";
  private shuttingDown = false;
  /** Set by the child `close` event — stdio EOF, the real "stdout drained" signal. */
  private childClosed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly worker: LogcatWorker,
    private readonly rawWriter: RawWriter,
    private readonly tracker: ProcessTracker,
    private readonly bufferInfo: LogcatBufferInfo,
  ) {}

  static async start(input: LogcatChannelInput): Promise<LogcatChannel> {
    const appUid = await getAppUid(input.deviceSerial, input.packageName, input.userId);
    const tracker = new ProcessTracker(
      input.deviceSerial,
      input.packageName,
      appUid,
      input.seedPids,
    );

    // Acquire resources behind a cleanup guard: a failure partway through must
    // not leak the pid-poll timer or the adb child / raw writer (P4-P1-3).
    let child: ChildProcess | null = null;
    let rawWriter: RawWriter | null = null;
    try {
      tracker.start();
      const spawned = await startLogcat({
        deviceSerial: input.deviceSerial,
        requestedBufferSize: input.requestedBufferSize,
        sinceEpochSec: input.startedAt.getTime() / 1000,
      });
      child = spawned.child;
      rawWriter = await RawWriter.open(`${input.runDir}/logcat.raw.txt`);
      // Human-readable anchor at the head of the raw file (§ D-M3).
      rawWriter.write(
        new TextEncoder().encode(`--- session_start ${input.startedAt.toISOString()} ---\n`),
      );

      const worker = new LogcatWorker({
        rawWriter,
        logcatStream: input.logcatStream,
        crashStream: input.crashStream,
        tracker,
        emitEvent: input.emitEvent,
      });
      const channel = new LogcatChannel(child, worker, rawWriter, tracker, spawned.bufferInfo);
      channel.wire(child, worker, input);
      log.info("logcat channel started", {
        packageName: input.packageName,
        bufferError: spawned.bufferInfo.error,
      });
      return channel;
    } catch (err) {
      tracker.stop();
      if (child !== null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // child may already be gone
        }
      }
      if (rawWriter !== null) {
        await rawWriter.close().catch(() => undefined);
      }
      throw err;
    }
  }

  private wire(child: ChildProcess, worker: LogcatWorker, input: LogcatChannelInput): void {
    child.on("close", () => {
      this.childClosed = true;
    });
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        void worker.onChunk(chunk);
      });
    }
    child.on("error", (err) => {
      void input.emitEvent({ type: "logcat_spawn_error", error: String(err) }).catch(() => {});
    });
    child.on("exit", (code, signal) => {
      // An exit while not shutting down is unexpected (device unplugged,
      // `adb kill-server`, logd crash, …).
      if (!this.shuttingDown) {
        this.state = "terminated";
        void input
          .emitEvent({ type: "logcat_terminated_unexpectedly", code, signal })
          .catch(() => {});
      }
    });
    if (this.bufferInfo.error !== null) {
      void input
        .emitEvent({
          type: "logcat_buffer_resize_failed",
          requested: this.bufferInfo.requested,
          effective: this.bufferInfo.effective,
          detail: this.bufferInfo.error,
        })
        .catch(() => {});
    }
  }

  get currentState(): LogcatState {
    return this.state;
  }

  /** § D-M1 shutdown. Safe to call once; returns the stats for `metadata.json`. */
  async shutdown(): Promise<LogcatShutdownInfo> {
    this.shuttingDown = true;
    this.tracker.stop();

    let killed = false;
    try {
      if (!this.childClosed) {
        this.child.kill("SIGTERM");
        if (!(await this.waitForClose(SHUTDOWN_GRACE_MS))) {
          killed = true;
          this.child.kill("SIGKILL");
          await this.waitForClose(SHUTDOWN_GRACE_MS);
        }
      }
      // The worker swallows derived-channel errors, so finish() does not reject.
      await this.worker.finish();
    } finally {
      // The raw channel is the truth source — flush + close it even if the
      // worker drain above somehow threw (P4-P1-1).
      await this.rawWriter.close();
    }
    if (this.state === "running") this.state = "stopped";

    const stats = this.worker.stats();
    return {
      exitCode: this.child.exitCode,
      signalCode: this.child.signalCode,
      killed,
      bytesRead: stats.bytesRead,
      linesParsed: stats.linesParsed,
      derivedErrors: stats.derivedErrors,
      bufferInfo: this.bufferInfo,
    };
  }

  /**
   * Resolve true once the child's `close` event has fired (stdio fully
   * drained), false on timeout. `close`, not `exit` — `exit` can fire while
   * stdout still has buffered `data` events pending (P4-P1-2).
   */
  private waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.childClosed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
