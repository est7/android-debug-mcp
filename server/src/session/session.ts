import {
  type ActiveScreenRecording,
  type ScreenRecordingStartInput,
  type ScreenRecordingStopResult,
  discardScreenRecording,
  startScreenRecording,
  stopScreenRecording,
} from "../adb/screenrecord.ts";
import { LogcatChannel } from "../logcat/channel.ts";
import { ToolDomainError } from "../mcp/toolError.ts";
import type { EvidenceContext, Profile } from "../profile/types.ts";
import { redactValue } from "../redact/redact.ts";
import type { LockHandle } from "../store/lock.ts";
import { type Metadata, type RunStatus, patchMetadata } from "../store/metadata.ts";
import type { RunFolder } from "../store/run.ts";
import {
  type DeviceConnectivity,
  type SessionHealthSnapshot,
  buildHealthSnapshot,
} from "./health.ts";
import type { SessionTimers } from "./timers.ts";

export type SessionLiveStatus = Extract<RunStatus, "active" | "degraded">;
export type SessionEndStatus = Extract<RunStatus, "stopped" | "aborted">;

/** An event record before this layer stamps `ts`. `type` is mandatory. */
export interface EventInput {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** A command record (real adb literal + tool args) before `ts` is stamped. */
export interface CommandInput {
  readonly tool: string;
  readonly [key: string]: unknown;
}

export interface SessionInit {
  readonly runId: string;
  readonly runFolder: RunFolder;
  readonly lock: LockHandle;
  readonly deviceSerial: string;
  readonly userId: number;
  readonly packageName: string;
  readonly startedAt: Date;
  readonly timers: SessionTimers;
  /**
   * v2-G Q11: the resolved built-in profile, or null for a vanilla session
   * (no `.android-debug-mcp/profile.json`). When null, every evidence tool
   * soft-empties; when non-null but `evidenceSources` is empty (Phase 3 with
   * poppo-vone whose sources land in Phase 4), tools also soft-empty.
   */
  readonly profile: Profile | null;
}

/**
 * One in-flight debug run. Owns its run folder's jsonl streams, its global
 * lock, and its auto-stop timers. Every `events.jsonl` / `commands.jsonl`
 * write goes through here so redaction (baked-in #4) and `ts` stamping cannot
 * be forgotten by a tool.
 */
export class Session {
  readonly runId: string;
  readonly runDir: string;
  readonly deviceSerial: string;
  readonly userId: number;
  readonly packageName: string;
  readonly startedAt: Date;
  readonly profile: Profile | null;

  private readonly runFolder: RunFolder;
  private readonly lock: LockHandle;
  private readonly timers: SessionTimers;

  private status: SessionLiveStatus | SessionEndStatus = "active";
  private deviceConnectivity: DeviceConnectivity = "connected";
  private logcat: LogcatChannel | null = null;
  private lastCommandAt: Date | null = null;
  private lastLogAt: Date | null = null;
  private cachedPids: number[] = [];
  /**
   * `persist.sys.timezone` captured later in start_session via getDeviceProps.
   * Stays null until then; tools that need it (search_evidence) tolerate null
   * by deferring to the source's filename-mtime heuristics. See
   * {@link EvidenceContext.deviceTimezone}.
   */
  private deviceTimezone: string | null = null;
  private screenRecording: {
    readonly recordingId: string;
    readonly startPromise: Promise<ActiveScreenRecording>;
  } | null = null;

  constructor(init: SessionInit) {
    this.runId = init.runId;
    this.runFolder = init.runFolder;
    this.runDir = init.runFolder.runDir;
    this.lock = init.lock;
    this.deviceSerial = init.deviceSerial;
    this.userId = init.userId;
    this.packageName = init.packageName;
    this.startedAt = init.startedAt;
    this.timers = init.timers;
    this.profile = init.profile;
  }

  /** Set on entry to start_session after `getDeviceProps` returns. */
  setDeviceTimezone(tz: string | null): void {
    this.deviceTimezone = tz;
  }

  /** Build the {@link EvidenceContext} an `EvidenceSource` needs at I/O time. */
  evidenceContext(): EvidenceContext {
    return {
      deviceSerial: this.deviceSerial,
      packageName: this.packageName,
      sessionStartMs: this.startedAt.getTime(),
      deviceTimezone: this.deviceTimezone,
    };
  }

  get currentStatus(): SessionLiveStatus | SessionEndStatus {
    return this.status;
  }

  get isActive(): boolean {
    return this.status === "active" || this.status === "degraded";
  }

  get pids(): readonly number[] {
    return this.cachedPids;
  }

  setPids(pids: readonly number[]): void {
    this.cachedPids = [...pids];
  }

  /** Append a semantic event to `events.jsonl` (redacted, `ts`-stamped). */
  async appendEvent(event: EventInput, now: Date = new Date()): Promise<string> {
    const ts = now.toISOString();
    const redacted = redactValue({ ...event, ts }) as Record<string, unknown>;
    await this.runFolder.streams.events.append(redacted);
    return ts;
  }

  /** Append a command record to `commands.jsonl` (redacted, `ts`-stamped). */
  async appendCommand(command: CommandInput, now: Date = new Date()): Promise<string> {
    const ts = now.toISOString();
    const redacted = redactValue({ ...command, ts }) as Record<string, unknown>;
    await this.runFolder.streams.commands.append(redacted);
    return ts;
  }

  /** Reset the idle timer + record the time of the last command. */
  touchCommand(now: Date = new Date()): void {
    this.lastCommandAt = now;
    this.timers.onActivity();
  }

  /** Phase 9 will call this when device connectivity is lost. */
  markDegraded(): void {
    if (this.status === "active") this.status = "degraded";
    this.deviceConnectivity = "degraded";
  }

  /**
   * Spawn the logcat dual channel for this run. The {@link LogcatChannel}
   * writes directly into the run folder's `logcat.jsonl` / `crash.jsonl`
   * streams (NOT via `appendEvent` — logcat lines carry their own device-clock
   * timestamp and are deliberately not redacted in v1, decision #6).
   */
  async startLogcat(input: {
    requestedBufferSize: string;
    seedPids: readonly number[];
  }): Promise<void> {
    this.logcat = await LogcatChannel.start({
      deviceSerial: this.deviceSerial,
      packageName: this.packageName,
      userId: this.userId,
      runDir: this.runDir,
      startedAt: this.startedAt,
      requestedBufferSize: input.requestedBufferSize,
      logcatStream: this.runFolder.streams.logcat,
      crashStream: this.runFolder.streams.crash,
      emitEvent: (event) => this.appendEvent(event),
      seedPids: input.seedPids,
    });
  }

  async beginScreenRecording(input: ScreenRecordingStartInput): Promise<ActiveScreenRecording> {
    if (this.screenRecording !== null) {
      throw new ToolDomainError(
        "screen_recording_active",
        `Recording ${this.screenRecording.recordingId} is already active for session ${this.runId}.`,
        { runId: this.runId, recordingId: this.screenRecording.recordingId },
      );
    }
    const startPromise = Promise.resolve().then(() => startScreenRecording(input));
    this.screenRecording = { recordingId: input.recordingId, startPromise };
    try {
      return await startPromise;
    } catch (err) {
      if (this.screenRecording?.recordingId === input.recordingId) this.screenRecording = null;
      throw err;
    }
  }

  async stopScreenRecording(
    recordingId: string,
  ): Promise<{ recording: ActiveScreenRecording; result: ScreenRecordingStopResult }> {
    const pending = this.screenRecording;
    if (pending === null || pending.recordingId !== recordingId) {
      throw new ToolDomainError(
        "screen_recording_not_active",
        `Recording ${recordingId} is not active for session ${this.runId}.`,
        {
          runId: this.runId,
          recordingId,
          activeRecordingId: pending?.recordingId ?? null,
        },
      );
    }
    const recording = await pending.startPromise;
    const result = await stopScreenRecording(recording);
    if (this.screenRecording === pending) this.screenRecording = null;
    return { recording, result };
  }

  private async finalizeScreenRecording(): Promise<void> {
    const pending = this.screenRecording;
    if (pending === null) return;
    try {
      const { recording, result } = await this.stopScreenRecording(pending.recordingId);
      await this.appendCommand({
        tool: "screen_recording",
        action: "stop",
        recordingId: recording.recordingId,
        adb: `kill -2 ${recording.remotePid}; adb pull ${recording.remotePath} ${recording.artifactPath}`,
        reason: "session_finalize",
      });
      await this.appendEvent({
        type: "screen_recording_saved",
        recordingId: recording.recordingId,
        videoPath: recording.artifactPath,
        byteSize: result.byteSize,
        durationMs: result.durationMs,
        forced: result.forced,
        contactSheet: result.contactSheet,
        reason: "session_finalize",
      });
    } catch (err) {
      const recording = await pending.startPromise.catch(() => null);
      if (recording !== null) await discardScreenRecording(recording).catch(() => undefined);
      this.screenRecording = null;
      await this.appendEvent({
        type: "screen_recording_finalize_failed",
        recordingId: pending.recordingId,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
  }

  healthSnapshot(): SessionHealthSnapshot {
    return buildHealthSnapshot({
      device: this.deviceConnectivity,
      logcat: this.logcat?.currentState ?? "stopped",
      startedAt: this.startedAt,
      lastLogAt: this.lastLogAt,
      lastCommandAt: this.lastCommandAt,
    });
  }

  /** Patch this run's `metadata.json` (atomic temp+rename under the hood). */
  async patchMetadata(patch: (current: Metadata) => Metadata): Promise<Metadata> {
    return patchMetadata(this.runDir, patch);
  }

  /**
   * Finalize the run. Four teardown steps, each run unconditionally — a
   * failure in one must NOT skip the others, or we leak file handles / strand
   * the lock. Errors are collected and the first is rethrown.
   *
   * Order is load-bearing:
   *   1. active screen recording finalization — writes its command/event and
   *      MP4 artifact before the run streams close.
   *   2. logcat shutdown (§ D-M1) — the worker's last appends must land in
   *      `logcat.jsonl` / `crash.jsonl` BEFORE step 3 closes those streams.
   *   3. metadata write — folds in logcat shutdown stats (exit code, bytes).
   *   4. close the run-folder jsonl streams.
   *   5. release the global lock.
   */
  async finalize(endStatus: SessionEndStatus, now: Date = new Date()): Promise<void> {
    if (!this.isActive) return;
    // A session that went `degraded` keeps that as its terminal status — the
    // run did not end cleanly, its device dropped. Only an `active` session
    // adopts the caller's stopped / aborted end status (§ design-lock: a
    // disconnect run's summary reports `degraded`).
    const finalStatus = this.status === "degraded" ? "degraded" : endStatus;
    this.status = finalStatus;
    this.timers.stop();

    const errors: unknown[] = [];
    await this.finalizeScreenRecording();
    let logcatPatch: (current: Metadata) => Metadata = (c) => c;
    if (this.logcat !== null) {
      try {
        const info = await this.logcat.shutdown();
        logcatPatch = (current) => ({
          ...current,
          exitCode: info.exitCode,
          signalCode: info.signalCode,
          killed: info.killed,
          bytesRead: info.bytesRead,
          linesParsed: info.linesParsed,
          // Fold the live crash count into metadata — symmetric with the
          // Phase 8 recovery path. Without this, a run that crashed but
          // stopped cleanly would keep `crashFound: false` despite a
          // populated crash.jsonl.
          crashFound: info.crashMarkers > 0,
          logcatBuffer: {
            ...current.logcatBuffer,
            effective: info.bufferInfo.effective,
            error: info.bufferInfo.error,
          },
        });
      } catch (err) {
        errors.push(err);
      }
    }
    try {
      await this.patchMetadata((current) =>
        logcatPatch({ ...current, closedAt: now.toISOString(), status: finalStatus }),
      );
    } catch (err) {
      errors.push(err);
    }
    try {
      await this.runFolder.closeStreams();
    } catch (err) {
      errors.push(err);
    }
    try {
      await this.lock.release();
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) throw errors[0];
  }
}
