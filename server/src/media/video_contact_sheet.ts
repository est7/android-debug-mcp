import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CONTACT_SHEET_FRAMES = 36;
const MAX_FRAMES_PER_SECOND = 8;
const MAX_COLUMNS = 6;
const TILE_WIDTH_PX = 270;
const FFMPEG_TIMEOUT_MS = 120_000;

interface RunProcessOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

export type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<void>;

export interface BuildVideoContactSheetInput {
  readonly videoPath: string;
  readonly contactSheetPath: string;
  readonly maxDurationSeconds: number;
}

export interface VideoContactSheet {
  readonly path: string;
  readonly frameCount: number;
  readonly columns: number;
  readonly rows: number;
  readonly order: "left_to_right_top_to_bottom";
}

export interface BuildVideoContactSheetResult {
  readonly contactSheet: VideoContactSheet | null;
  readonly warnings: readonly string[];
}

/**
 * Build one chronological contact sheet so an agent can inspect and cite the
 * motion sequence with a single image read. Temporary sampled frames never
 * enter the run folder; only the final sheet is retained beside the MP4.
 */
export async function buildVideoContactSheet(
  input: BuildVideoContactSheetInput,
  runProcess: RunProcess = defaultRunProcess,
): Promise<BuildVideoContactSheetResult> {
  let scratchDir: string | null = null;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), "adm-contact-sheet-"));
    const framesPerSecond = Math.min(
      MAX_FRAMES_PER_SECOND,
      MAX_CONTACT_SHEET_FRAMES / Math.max(1, input.maxDurationSeconds),
    );
    const sampledFramePattern = join(scratchDir, "frame-%03d.png");
    await runProcess(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-i",
        input.videoPath,
        "-vf",
        `fps=${formatRate(framesPerSecond)}`,
        "-frames:v",
        String(MAX_CONTACT_SHEET_FRAMES),
        sampledFramePattern,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );

    const frameCount = (await readdir(scratchDir)).filter((name) =>
      /^frame-\d{3}\.png$/.test(name),
    ).length;
    if (frameCount === 0) {
      return withoutContactSheet(
        "ffmpeg produced no sampled frames; MP4 was saved without a contact sheet",
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
        sampledFramePattern,
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
): Promise<void> {
  await execFileAsync(command, [...args], options);
}

function withoutContactSheet(warning: string): BuildVideoContactSheetResult {
  return { contactSheet: null, warnings: [warning] };
}

function formatRate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function contactSheetWarning(err: unknown): string {
  if ((err as { code?: string }).code === "ENOENT") {
    return "ffmpeg not found; MP4 was saved without a contact sheet";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ffmpeg contact sheet generation failed; MP4 is still available: ${message}`;
}
