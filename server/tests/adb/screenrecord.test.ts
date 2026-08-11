import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScreenRecording, stopScreenRecording } from "../../src/adb/screenrecord.ts";

const adb = vi.hoisted(() => ({
  calls: [] as string[][],
  stopped: false,
  processName: "screenrecord",
}));

vi.mock("../../src/adb/adb.ts", () => ({
  runAdb: async (args: readonly string[]) => {
    const copy = [...args];
    adb.calls.push(copy);
    const command = copy.join(" ");
    if (command.includes("nohup setsid screenrecord")) {
      return { args: copy, stdout: "4321\n", stderr: "", exitCode: 0 };
    }
    if (command.includes(" shell kill -2 4321")) adb.stopped = true;
    if (command.includes(" shell cat /proc/4321/cmdline")) {
      return {
        args: copy,
        stdout: adb.stopped ? "" : `${adb.processName}\u0000`,
        stderr: "",
        exitCode: adb.stopped ? 1 : 0,
      };
    }
    if (command.includes(" shell test -s ")) {
      return { args: copy, stdout: "", stderr: "", exitCode: 0 };
    }
    if (copy.includes("pull")) {
      const localPath = copy.at(-1) as string;
      writeFileSync(localPath, Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]), {
        flag: "w",
      });
    }
    return { args: copy, stdout: "", stderr: "", exitCode: 0 };
  },
}));

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-screenrecord-adb-"));
  adb.calls.length = 0;
  adb.stopped = false;
  adb.processName = "screenrecord";
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("screenrecord adb lifecycle", () => {
  it("detaches with nohup+setsid, stops by pid, pulls, and validates the MP4", async () => {
    const artifactPath = join(scratch, "recording.mp4");
    const recording = await startScreenRecording({
      recordingId: "abcdef123456",
      deviceSerial: "FAKEDEV0",
      remotePath: "/sdcard/android-debug-mcp-test.mp4",
      artifactPath,
      startedAt: new Date().toISOString(),
      maxDurationSeconds: 4,
      bitRate: 12_000_000,
    });

    expect(recording.remotePid).toBe(4321);
    const startCommand = adb.calls[0]?.join(" ") ?? "";
    expect(startCommand).toContain("nohup setsid screenrecord");
    expect(startCommand).toContain("--bit-rate 12000000 --time-limit 4");
    expect(startCommand).toContain(">/dev/null 2>&1 </dev/null & echo $!");

    const result = await stopScreenRecording(recording);
    expect(result.byteSize).toBe(12);
    expect(result.forced).toBe(false);
    expect(adb.calls.some((args) => args.join(" ").includes("shell kill -2 4321"))).toBe(true);
    expect(adb.calls.some((args) => args.includes("pull"))).toBe(true);
    expect(
      adb.calls.some((args) =>
        args.join(" ").includes("shell rm -f /sdcard/android-debug-mcp-test.mp4"),
      ),
    ).toBe(true);
  });

  it("does not signal a pid that was reused after screenrecord ended naturally", async () => {
    adb.processName = "com.example.unrelated";
    const result = await stopScreenRecording({
      recordingId: "abcdef123456",
      deviceSerial: "FAKEDEV0",
      remotePath: "/sdcard/android-debug-mcp-test.mp4",
      artifactPath: join(scratch, "natural-stop.mp4"),
      startedAt: new Date().toISOString(),
      maxDurationSeconds: 4,
      bitRate: 12_000_000,
      remotePid: 4321,
    });

    expect(result.byteSize).toBe(12);
    expect(adb.calls.some((args) => args.includes("kill"))).toBe(false);
    expect(adb.calls.some((args) => args.includes("pull"))).toBe(true);
  });
});
