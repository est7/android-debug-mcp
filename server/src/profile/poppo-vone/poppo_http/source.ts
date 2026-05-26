import { runAdb } from "../../../adb/adb.ts";
import { pullFile as adbPullFile, statMtimeMs } from "../../../adb/evidence.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../../types.ts";
import { type PoppoHttpQuery, PoppoHttpQuerySchema, matchPoppoHttpRecord } from "./match.ts";
import { type PoppoHttpRecord, parsePoppoHttpLine } from "./record.ts";
import { redactPoppoHttpRecord } from "./redact.ts";

/**
 * v2-G Phase 4 concrete `EvidenceSource`: Poppo's `http_*.jsonl` HTTP-logging
 * interceptor output (schema rev4 at
 * `submodulepoppo/docs/projects/http-log-jsonl-schema.md`).
 *
 * Reads from `/sdcard/Android/data/<packageName>/files/http-logs/` — the
 * external files dir is `adb pull`-able without `run-as` or root. The same
 * source impl works for both Poppo (`com.baitu.poppo`) and Vone
 * (`com.baitu.vone`) because both ship the same interceptor under the
 * shared `poppo-vone` profile; the per-package path comes from
 * `EvidenceContext.packageName` (Phase 4 amendment to Phase 3's ctx shape).
 *
 * Policy modules:
 *   - `record.ts` — zod schema + `parsePoppoHttpLine` (`.passthrough()` per
 *     schema § 兼容性规则, hard-reject `v !== 1`).
 *   - `match.ts`  — `PoppoHttpQuerySchema`, `matchPoppoHttpRecord`,
 *     `derivePoppoHttpOutcome` (R4 cascade).
 *   - `redact.ts` — Q6 hardcoded redaction policy.
 *
 * Phase 3 contract amendments this source needs:
 *   - `bindSession` — clamps the agent's `tsMsRange.from` to at least
 *     `ctx.sessionStartMs` so cross-run records in the same retention
 *     window don't leak (codex Phase 4 audit R1).
 *   - `sortKey`     — `[tsMs, runId, seq]` per schema's reader contract
 *     (codex Phase 4 audit R2; lex-paginated via the cursor's sort variant).
 */

const SOURCE_ID = "poppo_http" as const;

/** Device path of the producer's external files dir for `packageName`. */
function deviceLogsDir(packageName: string): string {
  return `/sdcard/Android/data/${packageName}/files/http-logs`;
}

const FILENAME_PATTERN = /^http_(\d{4}-\d{2}-\d{2})_(\d+)\.jsonl$/;

/**
 * One-day-buffered filename-date filter (schema § Q5+: filename uses device
 * local date; sessions that span midnight need the buffer).
 *
 * When `deviceTimezone` is null (device prop was unreadable at start), we
 * skip the date filter entirely — listing all `http_*.jsonl` is a small
 * over-fetch but correctness-safe. Producer's retention (3 days / 100 MiB)
 * keeps the worst case bounded.
 */
export function shouldKeepByFilenameDate(
  filename: string,
  sessionStartMs: number,
  deviceTimezone: string | null,
): boolean {
  const m = FILENAME_PATTERN.exec(filename);
  if (m === null) return false;
  const fileDate = m[1] as string; // YYYY-MM-DD
  if (deviceTimezone === null) return true; // no date filter — keep all
  const sessionStartLocalDate = localDateInZone(sessionStartMs, deviceTimezone);
  if (sessionStartLocalDate === null) return true; // tz unparseable → no filter
  const lowerBoundDate = shiftLocalDate(sessionStartLocalDate, -1);
  // String compare on YYYY-MM-DD is correct lex order.
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
    // Invalid tz string → Intl throws RangeError. Treat as "no filter".
    return null;
  }
}

/** Add `deltaDays` to a `YYYY-MM-DD` string (uses UTC math to avoid DST drift). */
function shiftLocalDate(yyyymmdd: string, deltaDays: number): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse `adb shell ls -1` stdout into clean basename strings. Empty lines
 * and lines containing whitespace are dropped — defensive against a future
 * BusyBox `ls` variant that prefixes with `total N` or similar.
 */
function parseLsOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/[\s]/.test(l));
}

/** Stat-fold helper: stat each candidate, skip the ones that disappeared. */
async function statCandidates(
  deviceSerial: string,
  dir: string,
  names: readonly string[],
): Promise<DeviceFileEntry[]> {
  const out: DeviceFileEntry[] = [];
  for (const name of names) {
    const path = `${dir}/${name}`;
    const mtimeMs = await statMtimeMs(deviceSerial, path);
    if (mtimeMs === null) continue; // stale ls entry — file rotated between list + stat
    out.push({ path, name, mtimeMs });
  }
  return out;
}

export const poppoHttpSource: EvidenceSource = {
  id: SOURCE_ID,

  querySchema: PoppoHttpQuerySchema,

  async listDeviceFiles(ctx: EvidenceContext): Promise<readonly DeviceFileEntry[]> {
    const dir = deviceLogsDir(ctx.packageName);
    // Use allowNonZero so a missing dir (ENOENT in the underlying ls) maps
    // to a soft empty rather than throwing — schema § listDeviceFiles
    // contract: "Returns `[]` (not an error) when the device dir is absent."
    const res = await runAdb(["-s", ctx.deviceSerial, "shell", "ls", "-1", dir], {
      timeoutMs: 8_000,
      allowNonZero: true,
    });
    if (res.exitCode !== 0) {
      // Distinguish "dir missing" (normal — vanilla app, debug build not run)
      // from "real adb failure" by looking for the canonical ENOENT message.
      // Anything else throws so the agent sees a clean diagnostic.
      const stderr = res.stderr.trim();
      if (/No such file or directory/i.test(stderr)) return [];
      throw new Error(
        `adb shell ls ${dir} exited ${res.exitCode}: ${stderr || res.stdout.trim() || "<no output>"}`,
      );
    }
    const names = parseLsOutput(res.stdout).filter((n) =>
      shouldKeepByFilenameDate(n, ctx.sessionStartMs, ctx.deviceTimezone),
    );
    return await statCandidates(ctx.deviceSerial, dir, names);
  },

  async pullFile(
    ctx: EvidenceContext,
    deviceFile: DeviceFileEntry,
    localPath: string,
  ): Promise<void> {
    await adbPullFile(ctx.deviceSerial, deviceFile.path, localPath);
  },

  parseLine(line: string): ParsedRecord | null {
    return parsePoppoHttpLine(line);
  },

  matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean {
    return matchPoppoHttpRecord(record as PoppoHttpRecord, query as PoppoHttpQuery);
  },

  redactForBundle(record: ParsedRecord): ParsedRecord {
    return redactPoppoHttpRecord(record as PoppoHttpRecord);
  },

  /**
   * R1 — clamp `tsMsRange.from` to at least `ctx.sessionStartMs`. The
   * producer's retention can include records from app process runs that
   * happened before the current MCP session started; without this floor a
   * vanilla `search_evidence({source:"poppo_http"})` returns history from
   * previous runs.
   */
  bindSession(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery {
    const q = query as PoppoHttpQuery;
    const providedFrom = q.tsMsRange?.from;
    const floor =
      providedFrom === undefined ? ctx.sessionStartMs : Math.max(providedFrom, ctx.sessionStartMs);
    const tsMsRange = { ...(q.tsMsRange ?? {}), from: floor };
    return { ...q, tsMsRange } as EvidenceQuery;
  },

  /**
   * R2 — `(tsMs, runId, seq)` per schema § "MCP 消费指南" reader contract.
   * `(runId, seq)` is the unique stable key per the schema; `tsMs` is the
   * primary sort. Runtime sorts the matched record buffer lex by this
   * tuple before paginating.
   */
  sortKey(record: ParsedRecord): readonly (string | number)[] {
    const r = record as PoppoHttpRecord;
    return [r.tsMs, r.runId, r.seq];
  },
};
