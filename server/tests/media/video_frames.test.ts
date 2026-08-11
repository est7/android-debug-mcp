import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractVideoFrames } from "../../src/media/video_frames.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-video-frames-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("extractVideoFrames", () => {
  it("stores bounded ffmpeg-sampled PNGs in the requested artifacts directory", async () => {
    const framesDir = join(scratch, "screenrecord-abcdef123456-frames");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = await extractVideoFrames(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        framesDir,
        maxDurationSeconds: 4,
      },
      async (command, args) => {
        calls.push({ command, args });
        writeFileSync(join(framesDir, "frame-001.png"), "PNG1");
        writeFileSync(join(framesDir, "frame-002.png"), "PNG2");
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("ffmpeg");
    expect(calls[0]?.args).toContain("fps=8");
    expect(calls[0]?.args).toContain("72");
    expect(result.framePaths).toEqual([
      join(framesDir, "frame-001.png"),
      join(framesDir, "frame-002.png"),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps extraction failure non-fatal and removes partial PNGs", async () => {
    const framesDir = join(scratch, "screenrecord-abcdef123456-frames");
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const result = await extractVideoFrames(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        framesDir,
        maxDurationSeconds: 180,
      },
      async (_command, args) => {
        expect(args).toContain("fps=0.4");
        writeFileSync(join(framesDir, "frame-001.png"), "PARTIAL");
        throw missing;
      },
    );

    expect(result.framePaths).toEqual([]);
    expect(result.warnings).toEqual(["ffmpeg not found; MP4 was saved without derived PNGs"]);
  });
});
