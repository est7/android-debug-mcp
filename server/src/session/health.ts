/**
 * Session health snapshot (§ E-m5).
 *
 * Phase 3 only *defines* the snapshot shape and a pure builder. Active device
 * connectivity polling and the `degraded` transition are Phase 9 work — until
 * then `device` stays `"connected"` and `logcat` stays `"stopped"` (no logcat
 * channel exists before Phase 4).
 */

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
