/**
 * Session health snapshot (§ E-m5) + the Phase 9 device-connectivity monitor.
 *
 * Phase 3 defined the snapshot shape and the pure builder; Phase 9 adds
 * {@link HealthMonitor}, the poll that flips a session to `degraded` when its
 * device drops off `adb`.
 */

import { type DeviceInfo, listDevices as adbListDevices } from "../adb/devices.ts";
import { createLogger } from "../mcp/log.ts";
import type { SessionManager } from "./manager.ts";

const log = createLogger("android-debug-mcp:health");

export type DeviceConnectivity = "connected" | "degraded";
export type LogcatState = "running" | "terminated" | "stopped";

export interface SessionHealthSnapshot {
  readonly device: DeviceConnectivity;
  readonly logcat: LogcatState;
  readonly startedAt: string;
  /** ts of the last logcat line written; null until Phase 4 wires logcat. */
  readonly lastLogAt: string | null;
  /** ts of the last interaction / lifecycle command. */
  readonly lastCommandAt: string | null;
}

export interface HealthInputs {
  readonly device: DeviceConnectivity;
  readonly logcat: LogcatState;
  readonly startedAt: Date;
  readonly lastLogAt: Date | null;
  readonly lastCommandAt: Date | null;
}

export function buildHealthSnapshot(inputs: HealthInputs): SessionHealthSnapshot {
  return {
    device: inputs.device,
    logcat: inputs.logcat,
    startedAt: inputs.startedAt.toISOString(),
    lastLogAt: inputs.lastLogAt ? inputs.lastLogAt.toISOString() : null,
    lastCommandAt: inputs.lastCommandAt ? inputs.lastCommandAt.toISOString() : null,
  };
}

/** Default device-connectivity poll interval. */
export const DEFAULT_HEALTH_POLL_MS = 5_000;

export interface HealthMonitorOptions {
  readonly intervalMs?: number;
  /** Injected for tests; defaults to the real `adb devices` enumeration. */
  readonly listDevices?: () => Promise<DeviceInfo[]>;
}

/**
 * Polls device connectivity and flips a session to `degraded` the moment its
 * device drops off `adb`. Once degraded, every device-touching tool rejects
 * via `requireConnectedSession`; the run model forbids reconnection — the
 * operator must stop and start a fresh session (§ design-lock disconnect row).
 * There is deliberately no transition back to `connected` in v1.
 */
export class HealthMonitor {
  private readonly manager: SessionManager;
  private readonly intervalMs: number;
  private readonly listDevices: () => Promise<DeviceInfo[]>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(manager: SessionManager, opts: HealthMonitorOptions = {}) {
    this.manager = manager;
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEALTH_POLL_MS;
    this.listDevices = opts.listDevices ?? adbListDevices;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.checkOnce().catch((err) => {
        log.warn("health poll tick failed", { error: String(err) });
      });
    }, this.intervalMs);
    // Do not let the poll timer alone keep the process alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One poll. Any active session whose device is no longer in `adb`'s `device`
   * state is marked degraded and gets a `device_disconnected` event. When the
   * `adb devices` enumeration itself fails the tick is skipped — adb being
   * unreachable cannot prove that one specific device dropped.
   */
  async checkOnce(): Promise<void> {
    const sessions = this.manager.listActive();
    if (sessions.length === 0) return;

    let connected: Set<string>;
    try {
      const devices = await this.listDevices();
      connected = new Set(devices.filter((d) => d.state === "device").map((d) => d.deviceSerial));
    } catch (err) {
      log.warn("device poll skipped — adb unreachable", { error: String(err) });
      return;
    }

    for (const session of sessions) {
      if (session.currentStatus === "degraded") continue;
      if (connected.has(session.deviceSerial)) continue;
      session.markDegraded();
      log.warn("session degraded — device disconnected", {
        runId: session.runId,
        deviceSerial: session.deviceSerial,
      });
      await session
        .appendEvent({ type: "device_disconnected", deviceSerial: session.deviceSerial })
        .catch((err) => {
          log.warn("device_disconnected event write failed", { error: String(err) });
        });
    }
  }
}
