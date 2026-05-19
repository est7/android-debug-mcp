import { runAdb } from "./adb.ts";
import { AdbExecError } from "./errors.ts";

export type DeviceState =
  | "device"
  | "offline"
  | "unauthorized"
  | "no permissions"
  | "authorizing"
  | "recovery"
  | "sideload"
  | "bootloader"
  | "unknown";

const KNOWN_STATES: ReadonlySet<DeviceState> = new Set<DeviceState>([
  "device",
  "offline",
  "unauthorized",
  "no permissions",
  "authorizing",
  "recovery",
  "sideload",
  "bootloader",
  "unknown",
]);

export interface DeviceListEntry {
  readonly deviceSerial: string;
  readonly state: DeviceState;
  /** `transport_id` from `adb devices -l`, when present. */
  readonly transportId?: string;
  /** `product:` field from `adb devices -l`, when present. */
  readonly product?: string;
  /** `model:` field from `adb devices -l`, when present. */
  readonly model?: string;
  /** `device:` field from `adb devices -l` (board name), when present. */
  readonly device?: string;
}

export interface DeviceInfo {
  readonly deviceSerial: string;
  readonly state: DeviceState;
  /** Resolved via `getprop ro.product.model` when state==="device"; falls back to `-l` parse otherwise. */
  readonly model: string | null;
  /** Resolved via `getprop ro.build.version.sdk` when state==="device". */
  readonly apiLevel: number | null;
  /** Resolved via `getprop ro.product.cpu.abi` when state==="device". */
  readonly abi: string | null;
}

const HEADER_RE = /^List of devices attached/;
const ENTRY_RE =
  /^(?<serial>\S+)\s+(?<state>device|offline|unauthorized|no permissions|authorizing|recovery|sideload|bootloader|unknown)(?:\s+(?<rest>.*))?$/;

/**
 * Parse `adb devices -l` stdout into structured entries. Tolerant of:
 *   - leading "List of devices attached" header
 *   - blank trailing lines / mixed whitespace
 *   - lines we cannot match (returned as `state: "unknown"`)
 *   - the multi-word "no permissions" state
 */
export function parseDevicesL(stdout: string): DeviceListEntry[] {
  const out: DeviceListEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (HEADER_RE.test(line)) continue;
    const match = ENTRY_RE.exec(line);
    if (!match || !match.groups) {
      const serial = line.split(/\s+/)[0];
      if (serial) {
        out.push({ deviceSerial: serial, state: "unknown" });
      }
      continue;
    }
    const { serial, state, rest } = match.groups;
    if (!serial || !state) continue;
    const normalizedState: DeviceState = KNOWN_STATES.has(state as DeviceState)
      ? (state as DeviceState)
      : "unknown";
    const entry: DeviceListEntry = {
      deviceSerial: serial,
      state: normalizedState,
      ...parseTrailingFields(rest ?? ""),
    };
    out.push(entry);
  }
  return out;
}

interface TrailingFields {
  transportId?: string;
  product?: string;
  model?: string;
  device?: string;
}

function parseTrailingFields(rest: string): TrailingFields {
  const fields: TrailingFields = {};
  for (const token of rest.split(/\s+/)) {
    const idx = token.indexOf(":");
    if (idx <= 0) continue;
    const key = token.slice(0, idx);
    const value = token.slice(idx + 1);
    if (value === "") continue;
    switch (key) {
      case "transport_id":
        fields.transportId = value;
        break;
      case "product":
        fields.product = value;
        break;
      case "model":
        fields.model = value;
        break;
      case "device":
        fields.device = value;
        break;
      default:
        // ignore: usb:..., other ROM-specific tokens
        break;
    }
  }
  return fields;
}

async function getProp(serial: string, prop: string): Promise<string | null> {
  try {
    const result = await runAdb(["-s", serial, "shell", "getprop", prop], {
      timeoutMs: 5_000,
      allowNonZero: true,
    });
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return value === "" ? null : value;
  } catch (err) {
    if (err instanceof AdbExecError) return null;
    throw err;
  }
}

async function enrichOne(entry: DeviceListEntry): Promise<DeviceInfo> {
  if (entry.state !== "device") {
    return {
      deviceSerial: entry.deviceSerial,
      state: entry.state,
      model: entry.model ?? null,
      apiLevel: null,
      abi: null,
    };
  }
  const [modelProp, apiProp, abiProp] = await Promise.all([
    getProp(entry.deviceSerial, "ro.product.model"),
    getProp(entry.deviceSerial, "ro.build.version.sdk"),
    getProp(entry.deviceSerial, "ro.product.cpu.abi"),
  ]);
  const parsedApi = apiProp === null ? null : Number.parseInt(apiProp, 10);
  return {
    deviceSerial: entry.deviceSerial,
    state: entry.state,
    model: modelProp ?? entry.model ?? null,
    apiLevel: parsedApi !== null && Number.isFinite(parsedApi) ? parsedApi : null,
    abi: abiProp,
  };
}

/**
 * Enumerate all devices currently visible to adb, enriched with model/apiLevel/abi
 * via `getprop` (only for state==="device" entries; others come back with null fields).
 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const result = await runAdb(["devices", "-l"]);
  const entries = parseDevicesL(result.stdout);
  return Promise.all(entries.map(enrichOne));
}
