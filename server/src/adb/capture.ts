import { writeFile } from "node:fs/promises";
import { runAdb, runAdbBinary } from "./adb.ts";

/**
 * Capture primitives — screenshot via `adb exec-out screencap -p`, UI hierarchy
 * via `adb shell uiautomator dump` (amendments § B / § F). `exec-out` (not
 * `shell`) keeps the PNG byte stream free of pty LF→CRLF translation.
 */

/** PNG signature — first 4 of the 8 magic bytes (`\x89PNG`). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Extract the `<hierarchy>…</hierarchy>` root element from raw uiautomator output. */
const HIERARCHY_RE = /<hierarchy\b[\s\S]*?<\/hierarchy>/;

/**
 * Screenshot the device into `destPath` as a PNG. Throws when screencap does
 * not return a PNG — a corrupt / empty capture is exceptional (the device is
 * connected and screencap is a core capability), not a graceful-null case.
 */
export async function captureScreenshot(deviceSerial: string, destPath: string): Promise<void> {
  const res = await runAdbBinary(["-s", deviceSerial, "exec-out", "screencap", "-p"], {
    timeoutMs: 15_000,
  });
  if (res.stdout.length < PNG_MAGIC.length || !res.stdout.subarray(0, 4).equals(PNG_MAGIC)) {
    throw new Error(
      `screencap did not return a PNG (got ${res.stdout.length} bytes); the device may not support exec-out screencap.`,
    );
  }
  await writeFile(destPath, res.stdout);
}

export interface UiDumpResult {
  /** false when both attempts failed — the caller returns null paths, never throws. */
  readonly ok: boolean;
  /** The hierarchy XML written to `destPath`, or null on failure. */
  readonly xml: string | null;
  /** Human-readable outcome for the run record. */
  readonly detail: string;
}

/**
 * Dump the current UI hierarchy into `destPath`.
 *
 * Two attempts (v1-implementation-plan risk note): a transient `null root node`
 * — uiautomator caught the screen mid-animation — clears on a retry. Each
 * attempt tries `/dev/tty` streaming first (no device temp file, v1-spike-C),
 * then a `/sdcard` file fallback for ROMs where `/dev/tty` streaming is
 * unavailable. Persistent failure returns `ok:false` rather than throwing, so
 * `capture` can still report a screenshot taken in the same call.
 */
export async function captureUiDump(deviceSerial: string, destPath: string): Promise<UiDumpResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const xml = (await dumpViaDevTty(deviceSerial)) ?? (await dumpViaFile(deviceSerial));
    if (xml !== null) {
      await writeFile(destPath, xml, "utf8");
      return { ok: true, xml, detail: `uiautomator dump ok (attempt ${attempt})` };
    }
  }
  return {
    ok: false,
    xml: null,
    detail: "uiautomator dump failed after retry (null root node or unsupported ROM)",
  };
}

/** `uiautomator dump /dev/tty` — XML streams to stdout, no device temp file. */
async function dumpViaDevTty(deviceSerial: string): Promise<string | null> {
  const res = await runAdb(["-s", deviceSerial, "shell", "uiautomator", "dump", "/dev/tty"], {
    timeoutMs: 20_000,
    allowNonZero: true,
  });
  if (res.exitCode !== 0) return null;
  return HIERARCHY_RE.exec(res.stdout)?.[0] ?? null;
}

/** `uiautomator dump <file>` then read it back with `exec-out cat`. */
async function dumpViaFile(deviceSerial: string): Promise<string | null> {
  const devicePath = "/sdcard/window_dump.xml";
  const dump = await runAdb(["-s", deviceSerial, "shell", "uiautomator", "dump", devicePath], {
    timeoutMs: 20_000,
    allowNonZero: true,
  });
  if (dump.exitCode !== 0 || /\bERROR\b/i.test(dump.stdout)) return null;
  const read = await runAdb(["-s", deviceSerial, "exec-out", "cat", devicePath], {
    timeoutMs: 10_000,
    allowNonZero: true,
  });
  // Best-effort cleanup; a stranded temp file is harmless.
  await runAdb(["-s", deviceSerial, "shell", "rm", "-f", devicePath], {
    timeoutMs: 5_000,
    allowNonZero: true,
  }).catch(() => undefined);
  if (read.exitCode !== 0) return null;
  return HIERARCHY_RE.exec(read.stdout)?.[0] ?? null;
}
