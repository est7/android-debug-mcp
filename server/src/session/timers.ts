/**
 * Per-session auto-stop timers (§ D).
 *
 *   - hard cap: 60 min wall-clock from session start, regardless of activity.
 *   - idle cap: 30 min since the last interaction / lifecycle command.
 *
 * The idle timer is reset by {@link SessionTimers.onActivity}; the hard timer
 * never resets. Whichever fires first invokes `onTimeout(reason)` exactly once
 * — after a fire, both timers are cleared so a session cannot be stopped
 * twice by its own timers.
 *
 * Uses plain `setTimeout`; unit tests drive it with `vi.useFakeTimers()`.
 */

export type TimeoutReason = "hard_cap" | "idle";

export interface SessionTimersOptions {
  readonly hardCapMs?: number;
  readonly idleCapMs?: number;
  readonly onTimeout: (reason: TimeoutReason) => void;
}

export const DEFAULT_HARD_CAP_MS = 60 * 60 * 1000;
export const DEFAULT_IDLE_CAP_MS = 30 * 60 * 1000;

export class SessionTimers {
  private readonly hardCapMs: number;
  private readonly idleCapMs: number;
  private readonly onTimeout: (reason: TimeoutReason) => void;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private fired = false;
  private stopped = false;

  constructor(opts: SessionTimersOptions) {
    this.hardCapMs = opts.hardCapMs ?? DEFAULT_HARD_CAP_MS;
    this.idleCapMs = opts.idleCapMs ?? DEFAULT_IDLE_CAP_MS;
    this.onTimeout = opts.onTimeout;
  }

  /** Arm both timers. Call once, right after the session is registered. */
  start(): void {
    if (this.stopped || this.fired) return;
    this.hardTimer = setTimeout(() => this.fire("hard_cap"), this.hardCapMs);
    this.armIdle();
  }

  /** Reset the idle timer. No-op once the session has stopped or timed out. */
  onActivity(): void {
    if (this.stopped || this.fired) return;
    this.armIdle();
  }

  /** Cancel both timers (normal stop_session). Idempotent. */
  stop(): void {
    this.stopped = true;
    this.clearAll();
  }

  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fire("idle"), this.idleCapMs);
  }

  private fire(reason: TimeoutReason): void {
    if (this.fired || this.stopped) return;
    this.fired = true;
    this.clearAll();
    this.onTimeout(reason);
  }

  private clearAll(): void {
    if (this.hardTimer !== null) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
