import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EVIDENCE_SUBDIR, MTIME_CACHE_FILENAME } from "../evidence/paths.ts";
import type { Profile } from "../profile/types.ts";
import { redactString } from "../redact/redact.ts";
import { readLinesFrom } from "../search/line_reader.ts";
import { AppendStream } from "../store/jsonl.ts";

/**
 * Per-line ceiling for evidence files re-written during bundle redaction.
 * External-producer evidence records can legitimately dwarf the default
 * 64 KiB cap (observed: Poppo i18n `lang.json` responses at ~670 KB). 1 MiB
 * covers the observed maximum with ~50% headroom; anything beyond is a signal
 * to investigate the producing endpoint, not silently swallow.
 */
const EVIDENCE_BUNDLE_MAX_LINE_BYTES = 1024 * 1024;

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
  /**
   * v2-G Q6 enforcement (Phase 5): the runId's resolved Profile, used to
   * redact each `evidence/<source.id>/*.jsonl` file through the source's
   * `redactForBundle` before tar. The handler MUST resolve the profile
   * before calling here and MUST throw `evidence_redaction_unavailable`
   * when the profile / sources can't be resolved against on-disk dirs;
   * passing `null` here is only valid when there are no evidence dirs.
   *
   * Evidence redaction runs INDEPENDENT of `logs` — even
   * `logs:"raw" + acknowledgeUnredacted:true` does NOT disable evidence
   * redaction. `acknowledgeUnredacted` is logcat-scope only.
   */
  readonly profile: Profile | null;
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
  const { runDir, runId, bundlesDir, logs, profile } = input;
  const staging = await mkdtemp(join(tmpdir(), "adm-bundle-"));
  try {
    const stageRunDir = join(staging, runId);
    await cp(runDir, stageRunDir, { recursive: true });
    // Q6 evidence redaction is mandatory and runs BEFORE applyLogsPolicy,
    // independent of `logs` mode — `logs:"raw"` only acks unredacted logcat,
    // never unredacted evidence.
    await redactEvidenceDir(stageRunDir, profile);
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

/**
 * Walk every `evidence/<source.id>/` subdir in the staged copy of the run
 * folder. For each:
 *   - Drop `.mtime-cache.json` — it stores host-absolute `localPath` entries
 *     from the producer machine; useless to a recipient and a small info-leak
 *     about the producer's filesystem layout.
 *   - For each `*.jsonl` file, stream it line-by-line, parse via
 *     `source.parseLine`, drop parse-null lines (consistent with the source
 *     contract — null = "this line is malformed/half-line, skip"; the source's
 *     own search path would not surface these either, so they must NOT leak
 *     to the bundle as raw bytes), run the parsed record through
 *     `source.redactForBundle`, and write the redacted JSON back over the
 *     file (atomic via tmp+rename).
 *
 * If `profile` is null and there are no evidence dirs, no-op. If there ARE
 * evidence dirs but `profile` is null, the caller (collect_bundle handler)
 * was supposed to throw `evidence_redaction_unavailable` BEFORE getting here;
 * we treat that as a contract bug and throw a plain Error so the bug is
 * visible in tests rather than silently shipping unredacted bytes.
 */
async function redactEvidenceDir(stageRunDir: string, profile: Profile | null): Promise<void> {
  const evidenceRoot = join(stageRunDir, EVIDENCE_SUBDIR);
  // Filter to directories only — mirrors `collect_bundle.ts:listEvidenceSourceIds`
  // so a stray non-directory under evidence/ is ignored consistently
  // (codex Phase 5 (i) post-impl non-blocking note).
  let sourceDirs: string[];
  try {
    const entries = await readdir(evidenceRoot, { withFileTypes: true });
    sourceDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return; // no evidence dirs — vanilla
    throw err;
  }
  if (sourceDirs.length === 0) return;
  if (profile === null) {
    throw new Error(
      "bundle: evidence/ subdirs exist but caller passed profile=null — handler should have thrown evidence_redaction_unavailable",
    );
  }
  const sourcesById = new Map(profile.evidenceSources.map((s) => [s.id, s]));
  for (const sourceId of sourceDirs) {
    const source = sourcesById.get(sourceId);
    if (source === undefined) {
      throw new Error(
        `bundle: evidence/${sourceId}/ has no matching source in profile '${profile.name}' — handler should have thrown evidence_redaction_unavailable`,
      );
    }
    const sourceDir = join(evidenceRoot, sourceId);
    // Drop mtime cache first so a later readdir doesn't try to redact it.
    await rm(join(sourceDir, MTIME_CACHE_FILENAME), { force: true });
    const files = await readdir(sourceDir);
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue; // ignore non-jsonl (binary attachments etc.)
      const inputPath = join(sourceDir, name);
      const outputPath = `${inputPath}.tmp-redact-${process.pid}-${Date.now()}`;
      const out = await AppendStream.open(outputPath, {
        maxLineBytes: EVIDENCE_BUNDLE_MAX_LINE_BYTES,
      });
      try {
        for await (const { text } of readLinesFrom(inputPath)) {
          const rec = source.parseLine(text);
          if (rec === null) continue; // parse-null skip; never copy raw to bundle
          const redacted = source.redactForBundle(rec);
          await out.append(redacted as Record<string, unknown>);
        }
      } finally {
        await out.close();
      }
      // Atomic replace: rename within the same fs is POSIX-atomic, so
      // a tar racing with the rename never sees a half-written file.
      await rename(outputPath, inputPath);
    }
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
