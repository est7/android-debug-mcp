import { redactValue } from "../redact/redact.ts";
import type { LockHandle } from "../store/lock.ts";
import { type Metadata, type RunStatus, patchMetadata } from "../store/metadata.ts";
import type { RunFolder } from "../store/run.ts";
import {
  type DeviceConnectivity,
  type LogcatState,
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

  private readonly runFolder: RunFolder;
  private readonly lock: LockHandle;
  private readonly timers: SessionTimers;

  private status: SessionLiveStatus | SessionEndStatus = "active";
  private deviceConnectivity: DeviceConnectivity = "connected";
  private logcatState: LogcatState = "stopped";
  private lastCommandAt: Date | null = null;
  private lastLogAt: Date | null = null;
  private cachedPids: number[] = [];

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

  healthSnapshot(): SessionHealthSnapshot {
    return buildHealthSnapshot({
      device: this.deviceConnectivity,
      logcat: this.logcatState,
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
   * Finalize the run: stop timers, write the closing metadata, flush+close all
   * jsonl streams, release the global lock.
   *
   * All three teardown steps run unconditionally — a failure in one (e.g. the
   * metadata write throwing) must NOT skip the others, or we would leak file
   * handles / strand the lock. Errors are collected and the first is rethrown
   * so the caller still learns finalize did not fully succeed, while the
   * cleanup itself is already complete.
   */
  async finalize(endStatus: SessionEndStatus, now: Date = new Date()): Promise<void> {
    if (!this.isActive) return;
    this.status = endStatus;
    this.timers.stop();

    const errors: unknown[] = [];
    try {
      await this.patchMetadata((current) => ({
        ...current,
        closedAt: now.toISOString(),
        status: endStatus,
      }));
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
