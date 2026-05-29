import { z } from "zod";
import { pullFile as adbPullFile } from "../../../adb/evidence.ts";
import type {
  DeviceFileEntry,
  EvidenceContext,
  EvidenceQuery,
  EvidenceSource,
  ParsedRecord,
} from "../../types.ts";
import { listDeviceLogFiles, shouldKeepByFilenameDate } from "../device_files.ts";
import { type PoppoNavRecord, parsePoppoNavLine } from "./record.ts";

const SOURCE_ID = "poppo_nav" as const;
const FILENAME_PATTERN = /^nav_(\d{4}-\d{2}-\d{2})_(\d+)\.jsonl$/;

function deviceLogsDir(packageName: string): string {
  return `/sdcard/Android/data/${packageName}/files/nav-logs`;
}

export const PoppoNavQuerySchema = z
  .object({
    source: z.literal(SOURCE_ID),
    tsMsRange: z
      .object({
        from: z.number().int(),
        to: z.number().int(),
      })
      .strict()
      .refine((r) => r.to >= r.from, "tsMsRange.to must be >= tsMsRange.from")
      .optional(),
    typeIn: z.array(z.string()).min(1).optional(),
    nameContains: z.string().min(1).optional(),
  })
  .strict();

export type PoppoNavQuery = z.output<typeof PoppoNavQuerySchema>;

export function shouldKeepNavByFilenameDate(
  filename: string,
  sessionStartMs: number,
  deviceTimezone: string | null,
): boolean {
  return shouldKeepByFilenameDate(filename, FILENAME_PATTERN, sessionStartMs, deviceTimezone);
}

export function matchPoppoNavRecord(record: ParsedRecord, query: EvidenceQuery): boolean {
  const r = record as PoppoNavRecord;
  const q = query as PoppoNavQuery;

  if (q.tsMsRange !== undefined) {
    if (r.tsMs < q.tsMsRange.from) return false;
    if (r.tsMs > q.tsMsRange.to) return false;
  }
  if (q.typeIn !== undefined && !q.typeIn.includes(r.type)) return false;
  if (
    q.nameContains !== undefined &&
    !r.name.toLowerCase().includes(q.nameContains.toLowerCase())
  ) {
    return false;
  }
  return true;
}

export const poppoNavSource: EvidenceSource = {
  id: SOURCE_ID,

  querySchema: PoppoNavQuerySchema,

  async listDeviceFiles(ctx: EvidenceContext): Promise<readonly DeviceFileEntry[]> {
    const dir = deviceLogsDir(ctx.packageName);
    return await listDeviceLogFiles(ctx.deviceSerial, dir, (name) =>
      shouldKeepNavByFilenameDate(name, ctx.sessionStartMs, ctx.deviceTimezone),
    );
  },

  async pullFile(
    ctx: EvidenceContext,
    deviceFile: DeviceFileEntry,
    localPath: string,
  ): Promise<void> {
    await adbPullFile(ctx.deviceSerial, deviceFile.path, localPath);
  },

  parseLine(line: string): ParsedRecord | null {
    return parsePoppoNavLine(line);
  },

  matchQuery(record: ParsedRecord, query: EvidenceQuery): boolean {
    return matchPoppoNavRecord(record, query);
  },

  redactForBundle(record: ParsedRecord): ParsedRecord {
    return record;
  },

  previewForAgent(record: ParsedRecord) {
    return {
      record,
      truncated: false,
      fullSizeBytes: Buffer.byteLength(JSON.stringify(record), "utf8"),
      truncatedFields: [],
      available: [],
      sizes: {},
    };
  },

  bindSession(query: EvidenceQuery, ctx: EvidenceContext): EvidenceQuery {
    const q = query as PoppoNavQuery;
    if (q.tsMsRange === undefined) return query;
    return {
      ...q,
      tsMsRange: {
        from: Math.max(q.tsMsRange.from, ctx.sessionStartMs),
        to: q.tsMsRange.to,
      },
    } as EvidenceQuery;
  },
};
