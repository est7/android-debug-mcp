import { getAppPids } from "../adb/app.ts";
import { createLogger } from "../mcp/log.ts";
import type { LogEntry } from "./parser.ts";

const log = createLogger("android-debug-mcp:logcat:proc");

/** How often the primary `pidof` poll runs. */
export const PID_POLL_INTERVAL_MS = 3_000;

/**
 * Tracks which processes belong to the session's app (§ C-2).
 *
 * `knownPids` is grow-only: once a pid is attributed to the app it stays, so a
 * crashed-and-respawned process's earlier log lines remain attributable. Two
 * sources feed it:
 *
 *   - **primary**: periodic `pidof` poll (`getAppPids`) — authoritative.
 *   - **supplementary**: `ActivityManager: Start proc <pid>:<pkg>/…` lines seen
 *     in the system buffer — faster to react than the poll.
 *
 * There is no real "conflict" to arbitrate: both sources only ever *add* pids,
 * and the poll is treated as authoritative for presence. `appUid` is captured
 * once at construction and used by the jsonl filter.
 */
export class ProcessTracker {
  private readonly pids = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deviceSerial: string,
    private readonly packageName: string,
    /** App uid as a string (matches logcat's `-v uid` column), or null if unknown. */
    readonly appUid: string | null,
    seedPids: readonly number[] = [],
  ) {
    for (const pid of seedPids) this.pids.add(pid);
  }

  get knownPids(): ReadonlySet<number> {
    return this.pids;
  }

  /** Begin the periodic `pidof` poll. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, PID_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one poll immediately (also called on the interval). */
  async poll(): Promise<void> {
    try {
      const pids = await getAppPids(this.deviceSerial, this.packageName);
      for (const pid of pids) this.pids.add(pid);
    } catch (err) {
      log.warn("pid poll failed", { packageName: this.packageName, error: String(err) });
    }
  }

  /**
   * Supplementary signal: an `ActivityManager: Start proc <pid>:<pkg>/…` line
   * for our package contributes its pid immediately, ahead of the next poll.
   */
  observeSystemLine(entry: LogEntry): void {
    if (entry.tag !== "ActivityManager") return;
    const m = /\bStart proc\s+(\d+):(\S+?)\//.exec(entry.message);
    if (!m) return;
    const pid = Number.parseInt(m[1] as string, 10);
    const proc = m[2] as string;
    // `proc` is the process name: the default process equals the package, a
    // private process is `<pkg>:suffix`. Match exact-or-`:` ONLY — a bare
    // `startsWith` would also accept a sibling package such as
    // `com.foo` matching `com.foobar` and pin a foreign pid forever (P4-P2-4).
    const isOurs = proc === this.packageName || proc.startsWith(`${this.packageName}:`);
    if (Number.isInteger(pid) && pid > 0 && isOurs) {
      this.pids.add(pid);
    }
  }
}
