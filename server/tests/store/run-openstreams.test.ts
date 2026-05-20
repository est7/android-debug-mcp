import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as jsonlMod from "../../src/store/jsonl.ts";
import { createRunDir } from "../../src/store/run.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-streamfail-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("createRunDir partial-stream cleanup", () => {
  it("closes previously-opened streams when the Nth AppendStream.open rejects", async () => {
    let callCount = 0;
    const closedSpy = vi.fn();
    const realOpen = jsonlMod.AppendStream.open.bind(jsonlMod.AppendStream);
    const spy = vi.spyOn(jsonlMod.AppendStream, "open").mockImplementation(async (path: string) => {
      callCount++;
      if (callCount === 4) {
        throw new Error("simulated 4th-stream failure");
      }
      const real = await realOpen(path);
      const origClose = real.close.bind(real);
      // biome-ignore lint/suspicious/noExplicitAny: spy needs to hook the real instance.
      (real as any).close = async () => {
        closedSpy(path);
        return origClose();
      };
      return real;
    });

    await expect(
      createRunDir({
        runRoot: scratch,
        runRootSource: "fallback",
        packageName: "com.example.app",
        userId: 0,
        runId: "2026-05-19T10-15-49.821Z_aAaA",
        deviceSerial: "TESTDEV1",
        startedAt: new Date("2026-05-19T10:15:49.821Z"),
      }),
    ).rejects.toThrow(/simulated 4th-stream failure/);

    // The first 3 streams that did open must have been closed by the cleanup.
    expect(closedSpy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
