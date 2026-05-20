import { join } from "node:path";
import { readLinesFrom } from "../search/line_reader.ts";
import { type Metadata, readMetadata } from "../store/metadata.ts";

export interface RunCounts {
  readonly events: number;
  readonly commands: number;
  readonly logcatLines: number;
  readonly crashes: number;
}

export interface CrashBrief {
  readonly type: string;
  readonly marker: string;
  readonly rawLineNo: number;
}

export interface RunData {
  readonly metadata: Metadata;
  readonly counts: RunCounts;
  /** Parsed `events.jsonl` records, in file order — the run timeline. */
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly crashes: ReadonlyArray<CrashBrief>;
}

/**
 * Gather everything a run summary needs from the run folder on disk. Works for
 * an active OR a finalized run — every file is read defensively (a missing or
 * malformed line is skipped, not fatal), since a summary must still render for
 * an aborted / partially-written run.
 */
export async function collectRunData(runDir: string): Promise<RunData> {
  const metadata = await readMetadata(runDir);
  const events = await readJsonlRecords(join(runDir, "events.jsonl"));
  const crashRecords = await readJsonlRecords(join(runDir, "crash.jsonl"));
  const counts: RunCounts = {
    events: events.length,
    commands: await countLines(join(runDir, "commands.jsonl")),
    logcatLines: await countLines(join(runDir, "logcat.jsonl")),
    crashes: crashRecords.length,
  };
  const crashes: CrashBrief[] = crashRecords.map((c) => ({
    type: typeof c.type === "string" ? c.type : "unknown",
    marker: typeof c.marker === "string" ? c.marker : "",
    rawLineNo: typeof c.rawLineNo === "number" ? c.rawLineNo : 0,
  }));
  return { metadata, counts, events, crashes };
}

async function readJsonlRecords(path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const { text } of readLinesFrom(path)) {
    try {
      const obj = JSON.parse(text);
      if (obj !== null && typeof obj === "object") out.push(obj as Record<string, unknown>);
    } catch {
      // A malformed line is skipped — the summary is best-effort.
    }
  }
  return out;
}

async function countLines(path: string): Promise<number> {
  let n = 0;
  for await (const _line of readLinesFrom(path)) n++;
  return n;
}
