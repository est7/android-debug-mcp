import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDomainError } from "../mcp/toolError.ts";
import { parsePoppoHttpLine } from "../profile/poppo-vone/poppo_http/record.ts";
import { Aliaser, type WireRecord, projectRecord } from "./project.ts";

/** Folder inside a run folder that holds snapshots and diff reports. */
export const WIRE_SUBDIR = "wire";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertLabel(label: string): void {
  if (!LABEL.test(label)) {
    throw new ToolDomainError(
      "invalid_argument",
      "label must be 1-64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit.",
      { label },
    );
  }
}

export interface SnapshotWindow {
  readonly fromTsMs?: number;
  readonly toTsMs?: number;
}

export interface SnapshotStats {
  readonly filesRead: number;
  readonly linesRead: number;
  /** Lines that are not a valid record (a half-written tail of the active file, or another schema). */
  readonly linesSkipped: number;
  readonly outsideWindow: number;
  readonly outsidePaths: number;
  readonly written: number;
  /** Encrypted requests whose `request.decoded` was missing; their fields are empty. */
  readonly undecoded: number;
  readonly withRole: number;
  readonly byPath: Readonly<Record<string, number>>;
  readonly aliases: Readonly<Record<string, number>>;
}

export interface Snapshot {
  readonly records: readonly WireRecord[];
  readonly stats: SnapshotStats;
}

/** Local `http_*.jsonl` files of a run's pulled evidence, oldest filename first. */
export async function localHttpLogs(evidenceDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(evidenceDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^http_.*\.jsonl$/.test(n))
    .sort()
    .map((n) => join(evidenceDir, n));
}

/**
 * Build a snapshot from local `http_*.jsonl` files: records are merged and ordered by `(tsMs, runId, seq)` as the
 * schema's reader contract says, filtered by window and paths, projected and redacted.
 */
export async function buildSnapshot(input: {
  readonly files: readonly string[];
  readonly only?: ReadonlySet<string>;
  readonly window?: SnapshotWindow;
}): Promise<Snapshot> {
  const parsed: NonNullable<ReturnType<typeof parsePoppoHttpLine>>[] = [];
  let linesRead = 0;
  let linesSkipped = 0;
  for (const file of input.files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      linesRead++;
      const record = parsePoppoHttpLine(line);
      if (record === null) linesSkipped++;
      else parsed.push(record);
    }
  }
  parsed.sort(
    (a, b) =>
      a.tsMs - b.tsMs || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0) || a.seq - b.seq,
  );

  const aliaser = new Aliaser();
  // Pass 1 learns every uid / phone / email in the log, so a value echoed under another key (an id sent as
  // `created_in_id`) is aliased too, whichever request shows it first. Its output is discarded.
  for (const record of parsed) projectRecord(record, aliaser, 0, { undecoded: 0 });
  const notes = { undecoded: 0 };
  const records: WireRecord[] = [];
  const byPath: Record<string, number> = {};
  let outsideWindow = 0;
  let outsidePaths = 0;
  for (const record of parsed) {
    const { fromTsMs, toTsMs } = input.window ?? {};
    if (
      (fromTsMs !== undefined && record.tsMs < fromTsMs) ||
      (toTsMs !== undefined && record.tsMs > toTsMs)
    ) {
      outsideWindow++;
      continue;
    }
    if (input.only !== undefined && input.only.size > 0 && !input.only.has(record.path)) {
      outsidePaths++;
      continue;
    }
    records.push(projectRecord(record, aliaser, records.length + 1, notes));
    byPath[record.path] = (byPath[record.path] ?? 0) + 1;
  }
  return {
    records,
    stats: {
      filesRead: input.files.length,
      linesRead,
      linesSkipped,
      outsideWindow,
      outsidePaths,
      written: records.length,
      undecoded: notes.undecoded,
      withRole: records.filter((r) => r.role !== null).length,
      byPath,
      aliases: aliaser.counts(),
    },
  };
}

/** Write `<dir>/<label>.jsonl` (+ a small `<label>.snapshot.json` sidecar) atomically; returns the jsonl path. */
export async function writeSnapshot(input: {
  readonly dir: string;
  readonly label: string;
  readonly snapshot: Snapshot;
  readonly meta: Readonly<Record<string, unknown>>;
}): Promise<string> {
  assertLabel(input.label);
  await mkdir(input.dir, { recursive: true });
  const path = join(input.dir, `${input.label}.jsonl`);
  const body = input.snapshot.records.map((r) => JSON.stringify(r)).join("\n");
  await atomicWrite(path, body === "" ? "" : `${body}\n`);
  await atomicWrite(
    join(input.dir, `${input.label}.snapshot.json`),
    `${JSON.stringify({ ...input.meta, label: input.label, stats: input.snapshot.stats }, null, 2)}\n`,
  );
  return path;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
