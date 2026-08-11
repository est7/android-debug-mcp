import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_FRAME_COUNT = 72;
const MAX_FRAMES_PER_SECOND = 8;
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

export interface ExtractVideoFramesInput {
  readonly videoPath: string;
  readonly framesDir: string;
  readonly maxDurationSeconds: number;
}

export interface ExtractVideoFramesResult {
  readonly framePaths: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Produce a bounded, evenly sampled visual index for an MP4.
 *
 * The configured recording duration is an upper bound, so choosing
 * `MAX_FRAME_COUNT / maxDurationSeconds` spans the whole video without
 * allowing long recordings to explode the run folder. Derived-frame failure
 * is deliberately soft: the validated MP4 remains the primary evidence.
 */
export async function extractVideoFrames(
  input: ExtractVideoFramesInput,
  runProcess: RunProcess = defaultRunProcess,
): Promise<ExtractVideoFramesResult> {
  const framesPerSecond = Math.min(
    MAX_FRAMES_PER_SECOND,
    MAX_FRAME_COUNT / Math.max(1, input.maxDurationSeconds),
  );
  const outputPattern = join(input.framesDir, "frame-%03d.png");

  try {
    await mkdir(input.framesDir, { recursive: true });
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
        String(MAX_FRAME_COUNT),
        outputPattern,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const framePaths = (await readdir(input.framesDir))
      .filter((name) => /^frame-\d{3}\.png$/.test(name))
      .sort()
      .map((name) => join(input.framesDir, name));
    if (framePaths.length === 0) {
      await rm(input.framesDir, { recursive: true, force: true });
      return {
        framePaths: [],
        warnings: ["ffmpeg produced no sampled frames; MP4 was saved without derived PNGs"],
      };
    }
    return { framePaths, warnings: [] };
  } catch (err) {
    await rm(input.framesDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      framePaths: [],
      warnings: [frameExtractionWarning(err)],
    };
  }
}

async function defaultRunProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<void> {
  await execFileAsync(command, [...args], options);
}

function formatRate(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function frameExtractionWarning(err: unknown): string {
  if ((err as { code?: string }).code === "ENOENT") {
    return "ffmpeg not found; MP4 was saved without derived PNGs";
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ffmpeg frame extraction failed; MP4 is still available: ${message}`;
}
