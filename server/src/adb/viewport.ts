/**
 * Probe the device's current viewport via `adb shell wm size`.
 *
 * Output format (canonical Android):
 *
 *   ```
 *   Physical size: 1080x2400
 *   Override size: 1440x3120
 *   ```
 *
 * `Override size` reflects an active `wm size <w>x<h>` developer override
 * (or e.g. fold-screen / Display Compatibility Mode tweaks) and SHOULD be
 * preferred when present — it is what the framework actually composites
 * against. `Physical size` is the panel's native resolution.
 *
 * Failure path is intentionally soft: if the command exits non-zero, the
 * stdout cannot be parsed, or the device is in an unusual ROM state that
 * emits a different format, the function returns `null`. Callers surface
 * a `viewport_unknown` warning and skip viewport-dependent filtering
 * rather than throwing — v2-F.3 § F3-Q4 lock decision.
 */

import { runAdb } from "./adb.ts";

const PHYSICAL_RE = /^Physical size:\s*(\d+)x(\d+)\s*$/m;
const OVERRIDE_RE = /^Override size:\s*(\d+)x(\d+)\s*$/m;

export interface Viewport {
  readonly w: number;
  readonly h: number;
}

export async function probeViewport(deviceSerial: string): Promise<Viewport | null> {
  let stdout: string;
  try {
    const res = await runAdb(["-s", deviceSerial, "shell", "wm", "size"], {
      timeoutMs: 5_000,
      allowNonZero: true,
    });
    if (res.exitCode !== 0) return null;
    stdout = res.stdout;
  } catch {
    return null;
  }

  // Override wins when both are present (developer override / fold mode).
  const override = OVERRIDE_RE.exec(stdout);
  if (override !== null) {
    const w = Number.parseInt(override[1] as string, 10);
    const h = Number.parseInt(override[2] as string, 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  }

  const physical = PHYSICAL_RE.exec(stdout);
  if (physical !== null) {
    const w = Number.parseInt(physical[1] as string, 10);
    const h = Number.parseInt(physical[2] as string, 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  }

  return null;
}
