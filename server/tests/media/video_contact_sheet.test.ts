import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVideoContactSheet } from "../../src/media/video_contact_sheet.ts";

let scratch = "";
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-video-contact-sheet-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("buildVideoContactSheet", () => {
  it.runIf(ffmpegAvailable)(
    "keeps a one-frame visual flash that time-interval sampling misses",
    async () => {
      const videoPath = join(scratch, "one-frame-flash.mp4");
      const contactSheetPath = join(scratch, "one-frame-flash-contact-sheet.png");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x180:r=30:d=2",
        "-vf",
        "drawbox=x=120:y=60:w=80:h=60:color=white:t=fill:enable='eq(n,33)',format=yuv420p",
        "-c:v",
        "mpeg4",
        "-q:v",
        "1",
        videoPath,
      ]);

      const result = await buildVideoContactSheet({
        videoPath,
        contactSheetPath,
      });

      expect(result.contactSheet).not.toBeNull();
      expect(result.contactSheet?.selection).toBe("visual_change");
      expect(result.contactSheet?.timestampsMs).toContain(1100);

      const sheet = PNG.sync.read(readFileSync(contactSheetPath));
      let nearWhitePixels = 0;
      for (let offset = 0; offset < sheet.data.length; offset += 4) {
        if (
          (sheet.data[offset] ?? 0) > 240 &&
          (sheet.data[offset + 1] ?? 0) > 240 &&
          (sheet.data[offset + 2] ?? 0) > 240
        ) {
          nearWhitePixels += 1;
        }
      }
      expect(nearWhitePixels).toBeGreaterThan(2_000);
    },
  );

  it("keeps one chronological PNG with referenceable grid metadata", async () => {
    const contactSheetPath = join(scratch, "screenrecord-abcdef123456-contact-sheet.png");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = await buildVideoContactSheet(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        contactSheetPath,
      },
      async (command, args) => {
        calls.push({ command, args });
        if (args.some((arg) => arg.includes("metadata=print:file=-"))) {
          return { stdout: visualDifferenceMetadata(), stderr: "" };
        }
        const outputPath = args.at(-1) as string;
        if (basename(outputPath) === "frame-%03d.png") {
          const frameDir = outputPath.slice(0, -basename(outputPath).length);
          for (let i = 1; i <= 3; i += 1) {
            writeFileSync(join(frameDir, `frame-${String(i).padStart(3, "0")}.png`), `PNG${i}`);
          }
        } else {
          writeFileSync(outputPath, "CONTACTSHEETPNG");
        }
        return { stdout: "", stderr: "" };
      },
    );

    expect(calls).toHaveLength(3);
    expect(calls[0]?.command).toBe("ffmpeg");
    expect(calls[0]?.args.some((arg) => arg.includes("tblend=all_mode=difference"))).toBe(true);
    expect(calls[0]?.args.some((arg) => arg.startsWith("fps="))).toBe(false);
    expect(calls[1]?.args).toContain("select=eq(n\\,0)+eq(n\\,2)+eq(n\\,3)");
    expect(calls[2]?.args).toContain("scale=270:-2,tile=3x1:padding=2:margin=0");
    expect(result.contactSheet).toEqual({
      path: contactSheetPath,
      frameCount: 3,
      columns: 3,
      rows: 1,
      order: "left_to_right_top_to_bottom",
      selection: "visual_change",
      timestampsMs: [0, 200, 300],
    });
    expect(result.warnings).toEqual([]);
    expect(existsSync(contactSheetPath)).toBe(true);
  });

  it("keeps the strongest transient across a busy recording while capping the sheet", async () => {
    const contactSheetPath = join(scratch, "busy-contact-sheet.png");
    const metadata = Array.from({ length: 100 }, (_, outputFrame) =>
      differenceBlock(outputFrame, (outputFrame + 1) / 10, outputFrame === 72 ? 200 : 2),
    ).join("\n");
    const result = await buildVideoContactSheet(
      { videoPath: join(scratch, "busy.mp4"), contactSheetPath },
      async (_command, args) => {
        if (args.some((arg) => arg.includes("metadata=print:file=-"))) {
          return { stdout: metadata, stderr: "" };
        }
        const outputPath = args.at(-1) as string;
        if (basename(outputPath) === "frame-%03d.png") {
          const frameDir = outputPath.slice(0, -basename(outputPath).length);
          const frameLimit = Number(args[args.indexOf("-frames:v") + 1]);
          for (let i = 1; i <= frameLimit; i += 1) {
            writeFileSync(join(frameDir, `frame-${String(i).padStart(3, "0")}.png`), `PNG${i}`);
          }
        } else {
          writeFileSync(outputPath, "CONTACTSHEETPNG");
        }
        return { stdout: "", stderr: "" };
      },
    );

    expect(result.contactSheet?.frameCount).toBe(36);
    expect(result.contactSheet?.timestampsMs[0]).toBe(0);
    expect(result.contactSheet?.timestampsMs).toContain(7300);
    expect(result.contactSheet?.timestampsMs.at(-1)).toBe(10_000);
    expect(result.contactSheet?.timestampsMs).toEqual(
      [...(result.contactSheet?.timestampsMs ?? [])].sort((left, right) => left - right),
    );
  });

  it("keeps ffmpeg failure non-fatal and removes a partial contact sheet", async () => {
    const contactSheetPath = join(scratch, "screenrecord-abcdef123456-contact-sheet.png");
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const result = await buildVideoContactSheet(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        contactSheetPath,
      },
      async (_command, args) => {
        expect(args.some((arg) => arg.includes("tblend=all_mode=difference"))).toBe(true);
        writeFileSync(contactSheetPath, "PARTIAL");
        throw missing;
      },
    );

    expect(result.contactSheet).toBeNull();
    expect(result.warnings).toEqual(["ffmpeg not found; MP4 was saved without a contact sheet"]);
    expect(existsSync(contactSheetPath)).toBe(false);
  });
});

function visualDifferenceMetadata(): string {
  return [differenceBlock(0, 0.1, 0), differenceBlock(1, 0.2, 20), differenceBlock(2, 0.3, 0)].join(
    "\n",
  );
}

function differenceBlock(frame: number, timestampSeconds: number, value: number): string {
  return [
    `frame:${frame} pts:${frame * 100} pts_time:${timestampSeconds}`,
    `lavfi.signalstats.YAVG=${value}`,
    `lavfi.signalstats.UAVG=${value}`,
    `lavfi.signalstats.VAVG=${value}`,
    `lavfi.signalstats.YHIGH=${value}`,
    `lavfi.signalstats.UHIGH=${value}`,
    `lavfi.signalstats.VHIGH=${value}`,
    `lavfi.signalstats.YMAX=${value}`,
    `lavfi.signalstats.UMAX=${value}`,
    `lavfi.signalstats.VMAX=${value}`,
  ].join("\n");
}
