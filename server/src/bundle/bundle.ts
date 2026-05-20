import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { redactString } from "../redact/redact.ts";
import { readLinesFrom } from "../search/line_reader.ts";
import { AppendStream } from "../store/jsonl.ts";

const execFileAsync = promisify(execFile);

/** Hard ceiling for the `tar` child — a debug-run bundle never legitimately runs this long. */
const TAR_TIMEOUT_MS = 120_000;

/** § C-4: how much of the logcat evidence the bundle carries. */
export type BundleLogs = "none" | "redacted" | "raw";

export interface BundleResult {
  readonly bundlePath: string;
  readonly byteSize: number;
  readonly logs: BundleLogs;
}

export interface CreateBundleInput {
  readonly runDir: string;
  readonly runId: string;
  /** Directory the archive is written into — kept OUTSIDE the staged input tree. */
  readonly bundlesDir: string;
  readonly logs: BundleLogs;
}

/**
 * Package a run folder into `<bundlesDir>/bundle-<runId>.tar.gz`.
 *
 * Built through a staging copy: the source run folder is never mutated, and
 * the archive is never written inside its own input. The `logs` policy (§ C-4):
 *   - `none`     — neither `logcat.jsonl` nor `logcat.raw.txt`.
 *   - `redacted` — `logcat.jsonl` re-emitted as `logcat.redacted.jsonl` with
 *     each line's `message` scrubbed by the Phase 5 matcher; no raw log.
 *   - `raw`      — `logcat.jsonl` + `logcat.raw.txt` verbatim (the caller must
 *     have acknowledged the unredacted export at the tool layer).
 */
export async function createBundle(input: CreateBundleInput): Promise<BundleResult> {
  const { runDir, runId, bundlesDir, logs } = input;
  const staging = await mkdtemp(join(tmpdir(), "adm-bundle-"));
  try {
    const stageRunDir = join(staging, runId);
    await cp(runDir, stageRunDir, { recursive: true });
    await applyLogsPolicy(stageRunDir, logs);
    await mkdir(bundlesDir, { recursive: true });
    const bundlePath = join(bundlesDir, `bundle-${runId}.tar.gz`);
    await execFileAsync("tar", ["-czf", bundlePath, "-C", staging, runId], {
      timeout: TAR_TIMEOUT_MS,
    });
    const byteSize = (await stat(bundlePath)).size;
    return { bundlePath, byteSize, logs };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function applyLogsPolicy(stageRunDir: string, logs: BundleLogs): Promise<void> {
  if (logs === "raw") return; // keep everything verbatim
  // `none` and `redacted` both drop the raw byte log.
  await rm(join(stageRunDir, "logcat.raw.txt"), { force: true });
  const jsonl = join(stageRunDir, "logcat.jsonl");
  if (logs === "none") {
    await rm(jsonl, { force: true });
    return;
  }
  // redacted: replace logcat.jsonl with a scrubbed logcat.redacted.jsonl.
  await redactLogcatJsonl(jsonl, join(stageRunDir, "logcat.redacted.jsonl"));
  await rm(jsonl, { force: true });
}

/**
 * Stream `logcat.jsonl`, scrubbing each entry's `message` through the Phase 5
 * string matcher (`Authorization` / `Cookie` headers, `token=` / `password=`
 * pairs, bare JWTs), and write the result to `outputPath`. A missing input is
 * a no-op — a run whose logcat never started simply has no redacted log.
 */
async function redactLogcatJsonl(inputPath: string, outputPath: string): Promise<void> {
  const inputExists = await stat(inputPath)
    .then(() => true)
    .catch(() => false);
  if (!inputExists) return;
  const out = await AppendStream.open(outputPath);
  try {
    for await (const { text } of readLinesFrom(inputPath)) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // a malformed logcat line is dropped from the redacted copy
      }
      if (typeof obj.message === "string") {
        obj.message = redactString(obj.message);
      }
      await out.append(obj);
    }
  } finally {
    await out.close();
  }
}
