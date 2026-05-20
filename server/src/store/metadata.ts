import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * `metadata.json` is the canonical record per run. It is written once at
 * `start_session` (`status=active`) and patched at well-defined boundaries
 * (`stop_session`, finalize-from-recovery, logcat buffer probe, etc).
 *
 * Layout intent (§ design-lock + § C-3 + § D-M1 + § D-M8):
 *   - Identity:      runId, deviceSerial, userId, packageName
 *   - Provenance:    runRoot, runRootSource (where it landed and why)
 *   - Timing:        startedAt, closedAt
 *   - Outcome:       status, exitCode, signalCode, killed, crashFound
 *   - Volumes:       bytesRead, linesParsed
 *   - Context:       app{versionName, versionCode}, device{...}, git{sha}
 *   - Logcat env:    logcatBuffer{requested, effective, buffers, error?}
 */
export const RunRootSourceSchema = z.enum(["explicit", "env", "cwd-git", "fallback"]);
export const RunStatusSchema = z.enum(["active", "degraded", "stopped", "aborted"]);

export const MetadataSchema = z
  .object({
    runId: z.string().min(1),
    deviceSerial: z.string().min(1),
    userId: z.number().int().nonnegative(),
    packageName: z.string().min(1),
    runRoot: z.string().min(1),
    runRootSource: RunRootSourceSchema,
    startedAt: z.string().datetime(),
    closedAt: z.string().datetime().nullable().default(null),
    status: RunStatusSchema,
    app: z
      .object({
        versionName: z.string().nullable().default(null),
        versionCode: z.string().nullable().default(null),
      })
      .strict()
      .default({ versionName: null, versionCode: null }),
    device: z
      .object({
        model: z.string().nullable().default(null),
        apiLevel: z.number().int().nullable().default(null),
        abi: z.string().nullable().default(null),
        buildFingerprint: z.string().nullable().default(null),
      })
      .strict()
      .default({ model: null, apiLevel: null, abi: null, buildFingerprint: null }),
    git: z
      .object({
        sha: z.string().nullable().default(null),
        dirty: z.boolean().nullable().default(null),
      })
      .strict()
      .default({ sha: null, dirty: null }),
    logcatBuffer: z
      .object({
        requested: z.string().nullable().default(null),
        effective: z.string().nullable().default(null),
        buffers: z.array(z.string()).default([]),
        error: z.string().nullable().default(null),
      })
      .strict()
      .default({ requested: null, effective: null, buffers: [], error: null }),
    exitCode: z.number().int().nullable().default(null),
    signalCode: z.string().nullable().default(null),
    killed: z.boolean().nullable().default(null),
    bytesRead: z.number().int().nonnegative().default(0),
    linesParsed: z.number().int().nonnegative().default(0),
    crashFound: z.boolean().default(false),
  })
  .strict();

export type Metadata = z.output<typeof MetadataSchema>;
export type MetadataInput = z.input<typeof MetadataSchema>;
export type RunStatus = z.output<typeof RunStatusSchema>;

export const METADATA_FILENAME = "metadata.json";

export async function readMetadata(runDir: string): Promise<Metadata> {
  const path = join(runDir, METADATA_FILENAME);
  const text = await readFile(path, "utf8");
  const raw = JSON.parse(text);
  return MetadataSchema.parse(raw);
}

export async function writeMetadata(runDir: string, metadata: MetadataInput): Promise<Metadata> {
  const parsed = MetadataSchema.parse(metadata);
  await writeMetadataAtomic(join(runDir, METADATA_FILENAME), parsed);
  return parsed;
}

/**
 * Read-modify-write a single metadata file atomically. The patch function
 * receives a deep clone of the parsed metadata; whatever it returns is the new
 * record (Zod-validated). Use `mergeMetadata` for shallow merges.
 */
export async function patchMetadata(
  runDir: string,
  patch: (current: Metadata) => MetadataInput,
): Promise<Metadata> {
  const current = await readMetadata(runDir);
  const next = MetadataSchema.parse(patch(structuredClone(current)));
  await writeMetadataAtomic(join(runDir, METADATA_FILENAME), next);
  return next;
}

/** Shallow merge helper: returns `{...current, ...partial}` for callers that prefer object spread. */
export function mergeMetadata(current: Metadata, partial: Partial<MetadataInput>): MetadataInput {
  return { ...current, ...partial };
}

async function writeMetadataAtomic(path: string, data: Metadata): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: "w" });
  await rename(tmp, path);
}

export function metadataDir(path: string): string {
  return dirname(path);
}
