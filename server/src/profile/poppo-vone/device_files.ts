import { runAdb } from "../../adb/adb.ts";
import { statDeviceFile } from "../../adb/evidence.ts";
import type { DeviceFileEntry } from "../types.ts";

/**
 * One-day-buffered filename-date filter for sources whose filenames embed a
 * device-local YYYY-MM-DD date.
 */
export function shouldKeepByFilenameDate(
  filename: string,
  filenamePattern: RegExp,
  sessionStartMs: number,
  deviceTimezone: string | null,
): boolean {
  const m = filenamePattern.exec(filename);
  if (m === null) return false;
  const fileDate = m[1] as string; // YYYY-MM-DD
  if (deviceTimezone === null) return true;
  const sessionStartLocalDate = localDateInZone(sessionStartMs, deviceTimezone);
  if (sessionStartLocalDate === null) return true;
  const lowerBoundDate = shiftLocalDate(sessionStartLocalDate, -1);
  return fileDate >= lowerBoundDate;
}

/** Format `epochMs` in `tz` as a `YYYY-MM-DD` local-date string. */
function localDateInZone(epochMs: number, tz: string): string | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(new Date(epochMs));
    let y = "";
    let mo = "";
    let d = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") mo = p.value;
      else if (p.type === "day") d = p.value;
    }
    if (y === "" || mo === "" || d === "") return null;
    return `${y}-${mo}-${d}`;
  } catch {
    // Invalid tz string -> no date filter.
    return null;
  }
}

/** Add `deltaDays` to a `YYYY-MM-DD` string (UTC math avoids DST drift). */
function shiftLocalDate(yyyymmdd: string, deltaDays: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse `adb shell ls -1` stdout into clean basename strings. Empty lines
 * and lines containing whitespace are dropped.
 */
function parseLsOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/[\s]/.test(l));
}

async function statCandidates(
  deviceSerial: string,
  dir: string,
  names: readonly string[],
): Promise<DeviceFileEntry[]> {
  const out: DeviceFileEntry[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    const stat = await statDeviceFile(deviceSerial, path);
    if (stat === null) continue;
    out.push({ path, name, mtimeMs: stat.mtimeMs, sizeBytes: stat.sizeBytes });
  }
  return out;
}

export async function listDeviceLogFiles(
  deviceSerial: string,
  dir: string,
  shouldKeepName: (name: string) => boolean,
): Promise<readonly DeviceFileEntry[]> {
  const res = await runAdb(["-s", deviceSerial, "shell", "ls", "-1", dir], {
    timeoutMs: 8_000,
    allowNonZero: true,
  });
  if (res.exitCode !== 0) {
    const stderr = res.stderr.trim();
    if (/No such file or directory/i.test(stderr)) return [];
    throw new Error(
      `adb shell ls ${dir} exited ${res.exitCode}: ${stderr || res.stdout.trim() || "<no output>"}`,
    );
  }
  const names = parseLsOutput(res.stdout).filter(shouldKeepName);
  return await statCandidates(deviceSerial, dir, names);
}
