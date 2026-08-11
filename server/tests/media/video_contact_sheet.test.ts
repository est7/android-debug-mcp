import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVideoContactSheet } from "../../src/media/video_contact_sheet.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-video-contact-sheet-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("buildVideoContactSheet", () => {
  it("keeps one chronological PNG with referenceable grid metadata", async () => {
    const contactSheetPath = join(scratch, "screenrecord-abcdef123456-contact-sheet.png");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = await buildVideoContactSheet(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        contactSheetPath,
        maxDurationSeconds: 4,
      },
      async (command, args) => {
        calls.push({ command, args });
        const outputPath = args.at(-1) as string;
        if (basename(outputPath) === "frame-%03d.png") {
          const frameDir = outputPath.slice(0, -basename(outputPath).length);
          for (let i = 1; i <= 15; i += 1) {
            writeFileSync(join(frameDir, `frame-${String(i).padStart(3, "0")}.png`), `PNG${i}`);
          }
        } else {
          writeFileSync(outputPath, "CONTACTSHEETPNG");
        }
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("ffmpeg");
    expect(calls[0]?.args).toContain("fps=8");
    expect(calls[0]?.args).toContain("36");
    expect(calls[1]?.args).toContain("scale=270:-2,tile=6x3:padding=2:margin=0");
    expect(result.contactSheet).toEqual({
      path: contactSheetPath,
      frameCount: 15,
      columns: 6,
      rows: 3,
      order: "left_to_right_top_to_bottom",
    });
    expect(result.warnings).toEqual([]);
    expect(existsSync(contactSheetPath)).toBe(true);
  });

  it("keeps ffmpeg failure non-fatal and removes a partial contact sheet", async () => {
    const contactSheetPath = join(scratch, "screenrecord-abcdef123456-contact-sheet.png");
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    const result = await buildVideoContactSheet(
      {
        videoPath: join(scratch, "screenrecord-abcdef123456.mp4"),
        contactSheetPath,
        maxDurationSeconds: 180,
      },
      async (_command, args) => {
        expect(args).toContain("fps=0.2");
        writeFileSync(contactSheetPath, "PARTIAL");
        throw missing;
      },
    );

    expect(result.contactSheet).toBeNull();
    expect(result.warnings).toEqual(["ffmpeg not found; MP4 was saved without a contact sheet"]);
    expect(existsSync(contactSheetPath)).toBe(false);
  });
});
