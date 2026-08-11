import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONTACT_SHEET_FRAMES = 36;
const MAX_COLUMNS = 6;
const TILE_WIDTH_PX = 270;
const ANALYSIS_WIDTH_PX = 160;
const MIN_VISUAL_CHANGE_SCORE = 0.5;
const MIN_CHANGE_DISTANCE_MS = 80;
const FFMPEG_TIMEOUT_MS = 120_000;
const FFMPEG_ANALYSIS_BUFFER_BYTES = 32 * 1024 * 1024;

interface RunProcessOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

interface RunProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<RunProcessResult>;

export interface BuildVideoContactSheetInput {
  readonly videoPath: string;
  readonly contactSheetPath: string;
}

export interface VideoContactSheet {
  readonly path: string;
  readonly frameCount: number;
  readonly columns: number;
  readonly rows: number;
  readonly order: "left_to_right_top_to_bottom";
  readonly selection: "visual_change";
  /** Cell-aligned presentation timestamps, rounded to milliseconds. */
  readonly timestampsMs: number[];
}

export interface BuildVideoContactSheetResult {
  readonly contactSheet: VideoContactSheet | null;
  readonly warnings: readonly string[];
}

interface DifferenceFrame {
  readonly frameNumber: number;
  readonly timestampMs: number;
  readonly score: number;
}

interface SelectedFrame {
  readonly frameNumber: number;
  readonly timestampMs: number;
  readonly kind: "boundary" | "visual_change";
}

const DIFFERENCE_KEYS = [
  "YAVG",
  "UAVG",
  "VAVG",
  "YHIGH",
  "UHIGH",
  "VHIGH",
  "YMAX",
  "UMAX",
  "VMAX",
] as const;

type DifferenceKey = (typeof DIFFERENCE_KEYS)[number];

/**
 * Build one chronological contact sheet from visually distinct moments. Every
 * decoded frame is compared with its predecessor; no fixed-time sampling is
 * used, so a one-frame flash remains eligible for selection. Temporary PNGs
 * never enter the run folder; only the final sheet is retained beside the MP4.
 */
export async function buildVideoContactSheet(
  input: BuildVideoContactSheetInput,
  runProcess: RunProcess = defaultRunProcess,
): Promise<BuildVideoContactSheetResult> {
  let scratchDir: string | null = null;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), "adm-contact-sheet-"));
    const analysis = await runProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input.videoPath,
        "-vf",
        `scale=${ANALYSIS_WIDTH_PX}:-2:flags=area,gblur=sigma=0.5,tblend=all_mode=difference,signalstats,metadata=print:file=-`,
        "-an",
        "-f",
        "null",
        "-",
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FFMPEG_ANALYSIS_BUFFER_BYTES },
    );
    const selectedFrames = selectVisualKeyFrames(parseDifferenceFrames(analysis.stdout));
    const selectedFramePattern = join(scratchDir, "frame-%03d.png");
    await runProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        input.videoPath,
        "-vf",
        buildFrameSelectionFilter(selectedFrames),
        "-fps_mode",
        "vfr",
        "-frames:v",
        String(selectedFrames.length),
        selectedFramePattern,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    const frameCount = (await readdir(scratchDir)).filter((name) =>
      /^frame-\d{3}\.png$/.test(name),
    ).length;
    if (frameCount !== selectedFrames.length) {
      throw new Error(
        `ffmpeg extracted ${frameCount} of ${selectedFrames.length} selected visual key frames`,
      );
    }

    const columns = Math.min(MAX_COLUMNS, frameCount);
    const rows = Math.ceil(frameCount / columns);
    await mkdir(dirname(input.contactSheetPath), { recursive: true });
    await runProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-framerate",
        "1",
        "-i",
        selectedFramePattern,
        "-vf",
        `scale=${TILE_WIDTH_PX}:-2,tile=${columns}x${rows}:padding=2:margin=0`,
        "-frames:v",
        "1",
        input.contactSheetPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    if ((await stat(input.contactSheetPath)).size === 0) {
      await rm(input.contactSheetPath, { force: true });
      return withoutContactSheet("ffmpeg produced an empty contact sheet; MP4 remains available");
    }
    return {
      contactSheet: {
        path: input.contactSheetPath,
        frameCount,
        columns,
        rows,
        order: "left_to_right_top_to_bottom",
        selection: "visual_change",
        timestampsMs: selectedFrames.map((frame) => frame.timestampMs),
      },
      warnings: [],
    };
  } catch (err) {
    await rm(input.contactSheetPath, { force: true }).catch(() => undefined);
    return withoutContactSheet(contactSheetWarning(err));
  } finally {
    if (scratchDir !== null) {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const result = await execFileAsync(command, [...args], options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function parseDifferenceFrames(output: string): DifferenceFrame[] {
  const records: DifferenceFrame[] = [];
  let outputFrameNumber: number | null = null;
  let timestampMs: number | null = null;
  let values: Partial<Record<DifferenceKey, number>> = {};

  const flush = () => {
    if (outputFrameNumber === null || timestampMs === null) return;
    if (!DIFFERENCE_KEYS.every((key) => Number.isFinite(values[key]))) {
      throw new Error(`ffmpeg omitted visual-difference metadata for frame ${outputFrameNumber}`);
    }
    records.push({
      frameNumber: outputFrameNumber + 1,
      timestampMs,
      score: differenceScore(values as Record<DifferenceKey, number>),
    });
  };

  for (const line of output.split(/\r?\n/)) {
    const frameMatch = /^frame:(\d+)\s+pts:\S+\s+pts_time:(\S+)/.exec(line);
    if (frameMatch !== null) {
      flush();
      outputFrameNumber = Number.parseInt(frameMatch[1] as string, 10);
      timestampMs = Math.round(Number.parseFloat(frameMatch[2] as string) * 1000);
      values = {};
      continue;
    }
    const valueMatch = /^lavfi\.signalstats\.([A-Z]+)=(\S+)/.exec(line);
    if (valueMatch !== null && DIFFERENCE_KEYS.includes(valueMatch[1] as DifferenceKey)) {
      values[valueMatch[1] as DifferenceKey] = Number.parseFloat(valueMatch[2] as string);
    }
  }
  flush();
  return records;
}

function differenceScore(values: Record<DifferenceKey, number>): number {
  const average = mean(values.YAVG, values.UAVG, values.VAVG);
  const high = mean(values.YHIGH, values.UHIGH, values.VHIGH);
  const maximum = mean(values.YMAX, values.UMAX, values.VMAX);
  return average + high * 0.25 + maximum * 0.01;
}

function mean(...values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function selectVisualKeyFrames(differences: readonly DifferenceFrame[]): SelectedFrame[] {
  if (differences.length === 0) {
    return [{ frameNumber: 0, timestampMs: 0, kind: "boundary" }];
  }

  const last = differences.at(-1) as DifferenceFrame;
  const selected = new Map<number, SelectedFrame>();
  selected.set(0, { frameNumber: 0, timestampMs: 0, kind: "boundary" });
  selected.set(last.frameNumber, {
    frameNumber: last.frameNumber,
    timestampMs: last.timestampMs,
    kind: "boundary",
  });

  const candidates = differences.filter((frame) => frame.score >= MIN_VISUAL_CHANGE_SCORE);
  const available = MAX_CONTACT_SHEET_FRAMES - selected.size;
  const coverageSlots = Math.max(1, Math.ceil(available / 2));
  for (let slot = 0; slot < coverageSlots && selected.size < MAX_CONTACT_SHEET_FRAMES; slot += 1) {
    const startMs = (last.timestampMs * slot) / coverageSlots;
    const endMs = (last.timestampMs * (slot + 1)) / coverageSlots;
    const best = candidates
      .filter(
        (frame) =>
          frame.timestampMs >= startMs &&
          (slot === coverageSlots - 1 ? frame.timestampMs <= endMs : frame.timestampMs < endMs),
      )
      .sort(compareByScoreThenTime)[0];
    if (best !== undefined) addVisualChange(selected, best);
  }

  for (const candidate of [...candidates].sort(compareByScoreThenTime)) {
    if (selected.size >= MAX_CONTACT_SHEET_FRAMES) break;
    if (
      [...selected.values()].some(
        (frame) =>
          frame.kind === "visual_change" &&
          Math.abs(frame.timestampMs - candidate.timestampMs) < MIN_CHANGE_DISTANCE_MS,
      )
    ) {
      continue;
    }
    addVisualChange(selected, candidate);
  }

  return [...selected.values()].sort((left, right) => left.frameNumber - right.frameNumber);
}

function addVisualChange(selected: Map<number, SelectedFrame>, frame: DifferenceFrame): void {
  if (selected.has(frame.frameNumber)) return;
  selected.set(frame.frameNumber, {
    frameNumber: frame.frameNumber,
    timestampMs: frame.timestampMs,
    kind: "visual_change",
  });
}

function compareByScoreThenTime(left: DifferenceFrame, right: DifferenceFrame): number {
  return right.score - left.score || left.frameNumber - right.frameNumber;
}

function buildFrameSelectionFilter(frames: readonly SelectedFrame[]): string {
  const expression = frames.map((frame) => `eq(n\\,${frame.frameNumber})`).join("+");
  return `select=${expression}`;
}

function withoutContactSheet(warning: string): BuildVideoContactSheetResult {
  return { contactSheet: null, warnings: [warning] };
}

function contactSheetWarning(err: unknown): string {
  if ((err as { code?: string }).code === "ENOENT") {
    return "ffmpeg not found; MP4 was saved without a contact sheet";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ffmpeg visual key-frame contact sheet generation failed; MP4 is still available: ${message}`;
}
