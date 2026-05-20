import { readFile, writeFile } from "node:fs/promises";
import { AppendStream } from "../store/jsonl.ts";
import { detectCrashSignature } from "./crash_marker.ts";
import { type FilterContext, shouldKeep } from "./filter.ts";
import { type LogEntry, looksTruncated, parseThreadtimeLine } from "./parser.ts";

/**
 * Rebuild `logcat.jsonl` + `crash.jsonl` from an existing `logcat.raw.txt`.
 *
 * Used by Phase 8 orphan recovery: when a session died without a clean
 * shutdown, the raw byte log is still intact (it is the truth source — § C-1)
 * but the derived jsonl may be incomplete. `replayParse` re-runs the parse /
 * continuation-merge / filter pipeline over the raw file from scratch.
 *
 * Both output files are truncated first, so a partial pre-crash jsonl is
 * replaced rather than appended to.
 */

export interface ReplayInput {
  readonly rawPath: string;
  readonly logcatJsonlPath: string;
  readonly crashJsonlPath: string;
  readonly filter: FilterContext;
}

export interface ReplayResult {
  readonly linesParsed: number;
  readonly crashMarkers: number;
}

interface Pending {
  readonly base: LogEntry;
  message: string;
  readonly rawLineNo: number;
  readonly buffer: string;
}

export async function replayParse(input: ReplayInput): Promise<ReplayResult> {
  const raw = await readFile(input.rawPath, "utf8");
  // Truncate the derived files — a recovered run rebuilds them from scratch.
  await Promise.all([writeFile(input.logcatJsonlPath, ""), writeFile(input.crashJsonlPath, "")]);
  const logcatStream = await AppendStream.open(input.logcatJsonlPath);
  const crashStream = await AppendStream.open(input.crashJsonlPath);

  let rawLineNo = 0;
  let rawByteCount = 0;
  let linesParsed = 0;
  let crashMarkers = 0;
  let currentBuffer = "main";
  let pending: Pending | null = null;

  const flush = async (): Promise<void> => {
    if (pending === null) return;
    const merged: LogEntry = { ...pending.base, message: pending.message };
    const entry = pending;
    pending = null;
    linesParsed += 1;
    if (!shouldKeep(merged, input.filter)) return;
    await logcatStream.append({
      tsRaw: merged.tsRaw,
      rawLineNo: entry.rawLineNo,
      rawByteCount: entry.rawLineNo, // recovery: per-line byte offset is not reconstructed
      buffer: entry.buffer,
      uid: merged.uid,
      pid: merged.pid,
      tid: merged.tid,
      level: merged.level,
      tag: merged.tag,
      message: merged.message,
      ...(looksTruncated(merged.message) ? { truncatedSuspect: true } : {}),
    });
  };

  try {
    for (const line of raw.split("\n")) {
      // The trailing empty segment after the final '\n' is not a real line.
      if (line === "" && rawByteCount >= raw.length) break;
      rawLineNo += 1;
      rawByteCount += Buffer.byteLength(line, "utf8") + 1;

      const crash = detectCrashSignature(line);
      if (crash) {
        crashMarkers += 1;
        await crashStream.append({ rawLineNo, type: crash.type, marker: crash.marker, line });
      }

      const result = parseThreadtimeLine(line);
      if (result.kind === "entry") {
        await flush();
        pending = {
          base: result.entry,
          message: result.entry.message,
          rawLineNo,
          buffer: currentBuffer,
        };
      } else if (result.kind === "continuation" || result.kind === "unparsed") {
        if (pending !== null) pending.message += `\n${result.text}`;
      } else if (result.kind === "buffer_switch") {
        currentBuffer = result.buffer;
      }
    }
    await flush();
  } finally {
    await crashStream.close();
    await logcatStream.close();
  }
  return { linesParsed, crashMarkers };
}
