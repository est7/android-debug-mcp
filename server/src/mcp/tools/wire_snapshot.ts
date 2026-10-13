import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sourceEvidenceDir } from "../../evidence/paths.ts";
import { sealEvidenceSource } from "../../evidence/runtime.ts";
import { poppoHttpSource } from "../../profile/poppo-vone/poppo_http/source.ts";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import {
  WIRE_SUBDIR,
  assertLabel,
  buildSnapshot,
  localHttpLogs,
  writeSnapshot,
} from "../../wire/snapshot.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput, touch } from "./_shared.ts";

const pathInput = z
  .string()
  .min(2, "paths must start with '/'")
  .max(256)
  .refine((p) => p.startsWith("/"), "paths must start with '/'");

const inputSchema = z
  .object({
    runId: runIdInput.optional(),
    files: z.array(z.string().min(1).max(1024)).min(1).max(32).optional(),
    outDir: z.string().min(1).max(1024).optional(),
    label: z.string().min(1).max(64).default("snapshot"),
    only: z.array(pathInput).min(1).max(64).optional(),
    fromTsMs: z.number().int().nonnegative().optional(),
    toTsMs: z.number().int().nonnegative().optional(),
    fromMark: z.string().min(1).max(128).optional(),
    toMark: z.string().min(1).max(128).optional(),
    pull: z.boolean().default(true),
  })
  .strict();

const outputSchema = z
  .object({
    label: z.string(),
    path: z.string(),
    metaPath: z.string(),
    runId: z.string().optional(),
    window: z
      .object({ fromTsMs: z.number().int().optional(), toTsMs: z.number().int().optional() })
      .strict(),
    pulled: z.object({ files: z.number().int(), bytes: z.number().int() }).strict().optional(),
    filesRead: z.number().int(),
    written: z.number().int(),
    linesRead: z.number().int(),
    linesSkipped: z.number().int(),
    outsideWindow: z.number().int(),
    outsidePaths: z.number().int(),
    undecoded: z.number().int(),
    withRole: z.number().int(),
    byPath: z.record(z.string(), z.number().int()),
    aliases: z.record(z.string(), z.number().int()),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const description = [
  "Project a run's HTTP log (`http_*.jsonl`) into a redacted request-parameter snapshot that `android_debug_wire_diff` can compare with another build's snapshot, so device regressions can be checked without app-side recorders.",
  "",
  "Use when: a candidate build and a reference build were driven through the same account flow (sign-in, switch, rebind) and their requests must be compared by parameters, not by eye. Run it once per build, then diff the two snapshots.",
  'Args: `runId` (a run; an active session first pulls the device\'s http-logs, a finished run uses what it already pulled) OR `files` (absolute paths of local `http_*.jsonl`) plus `outDir`; `label` (snapshot name, default `snapshot`); `only` (exact request paths, e.g. `["/user/login"]`); window: `fromTsMs`/`toTsMs` (epoch ms) or `fromMark`/`toMark` (names from `mark_event`, last occurrence; explicit ms win); `pull` (default true; false skips the device pull of an active session).',
  "Returns: `{label, path, metaPath, window, filesRead, written, linesRead, linesSkipped, outsideWindow, outsidePaths, undecoded, withRole, byPath, aliases, warnings?}`. The snapshot is `<runDir>/wire/<label>.jsonl` (or `<outDir>/<label>.jsonl`), one record per request in the recorder shape: `method`, `path`, `query` pairs, `headers` names, `encrypted`, `fields` (decoded `_random`/`_sign` keys, or the form / query fields), `role` (from `request.owner.role` when the producer writes it, else null), `time`, `seq`. Credentials, codes, tokens and device ids are `<redacted>` by key name (empty stays empty); uid / phone / email values are stable per-snapshot aliases (`<uid:1>`, `<phone:1>`, `<email:1>`). `aliases` and `byPath` are counts only.",
  "Errors: `invalid_argument` for a bad `label`, missing/relative paths, a reversed window or neither `runId` nor `files`; `run_missing` for an unknown runId; `mark_not_found` when a named mark is not in the run; `adb_command_failed` / `adb_not_found` / `device_disconnected` when the device pull fails.",
].join("\n");

export function registerWireSnapshot(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_wire_snapshot",
    {
      title: "Snapshot request parameters",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      assertLabel(input.label);
      if (input.runId === undefined && input.files === undefined) {
        throw invalid("Pass `runId` or `files`.");
      }
      if (input.runId === undefined && input.outDir === undefined) {
        throw invalid("`files` without `runId` needs `outDir`.");
      }
      for (const p of [
        ...(input.files ?? []),
        ...(input.outDir !== undefined ? [input.outDir] : []),
      ]) {
        if (!isAbsolute(p)) throw invalid(`Path must be absolute: ${p}`);
      }

      const warnings: string[] = [];
      let runDir: string | undefined;
      let pulled: { files: number; bytes: number } | undefined;
      if (input.runId !== undefined) {
        runDir = await resolveRunDir(manager, input.runId);
        const session = manager.listActive().find((s) => s.runId === input.runId);
        if (session !== undefined) {
          touch(session);
          if (input.pull && input.files === undefined) {
            if (session.currentStatus === "degraded") {
              warnings.push("device is degraded: using the evidence already pulled.");
            } else {
              const pulls = await sealEvidenceSource({
                source: poppoHttpSource,
                ctx: session.evidenceContext(),
                runDir,
              });
              const bytes = pulls.reduce((sum, p) => sum + p.sizeBytes, 0);
              pulled = { files: pulls.length, bytes };
              if (pulls.length > 0) {
                await session.appendEvent({
                  type: "evidence_pulled",
                  source: poppoHttpSource.id,
                  trigger: "lazy",
                  files: pulls.map((p) => basename(p.localPath)),
                  bytesPulled: bytes,
                  fileBytes: pulls.map((p) => ({
                    file: basename(p.localPath),
                    bytes: p.sizeBytes,
                  })),
                });
              }
            }
          }
        }
      }

      const window = await resolveWindow(input, runDir);
      const files =
        input.files ??
        (await localHttpLogs(sourceEvidenceDir(runDir as string, poppoHttpSource.id)));
      if (files.length === 0) {
        warnings.push(
          "no http_*.jsonl available for this run: nothing was pulled or found locally.",
        );
      }

      const snapshot = await buildSnapshot({
        files,
        ...(input.only !== undefined ? { only: new Set(input.only) } : {}),
        window,
      });
      const dir = input.outDir ?? join(runDir as string, WIRE_SUBDIR);
      const path = await writeSnapshot({
        dir,
        label: input.label,
        snapshot,
        meta: {
          createdAt: new Date().toISOString(),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          window,
          ...(input.only !== undefined ? { only: input.only } : {}),
          sources: files.map((f) => basename(f)),
        },
      });

      const { stats } = snapshot;
      if (stats.written === 0) warnings.push("the snapshot is empty: check `only` and the window.");
      if (stats.written > 0 && stats.withRole === 0) {
        warnings.push(
          "no record carries request.owner.role: role is null everywhere, so `android_debug_wire_diff` compares without role (baseline_diff.py cannot read null roles).",
        );
      }
      if (stats.undecoded > 0) {
        warnings.push(
          `${stats.undecoded} encrypted request(s) had no request.decoded: their fields are empty.`,
        );
      }

      return ok({
        label: input.label,
        path,
        metaPath: path.replace(/\.jsonl$/, ".snapshot.json"),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        window,
        ...(pulled !== undefined ? { pulled } : {}),
        filesRead: stats.filesRead,
        written: stats.written,
        linesRead: stats.linesRead,
        linesSkipped: stats.linesSkipped,
        outsideWindow: stats.outsideWindow,
        outsidePaths: stats.outsidePaths,
        undecoded: stats.undecoded,
        withRole: stats.withRole,
        byPath: stats.byPath,
        aliases: stats.aliases,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );
}

function invalid(message: string): ToolDomainError {
  return new ToolDomainError("invalid_argument", message);
}

async function resolveWindow(
  input: z.output<typeof inputSchema>,
  runDir: string | undefined,
): Promise<{ fromTsMs?: number; toTsMs?: number }> {
  let fromTsMs = input.fromTsMs;
  let toTsMs = input.toTsMs;
  if (
    (input.fromMark !== undefined && fromTsMs === undefined) ||
    (input.toMark !== undefined && toTsMs === undefined)
  ) {
    if (runDir === undefined) throw invalid("Marks need a `runId`.");
    const marks = await readMarks(runDir);
    if (fromTsMs === undefined && input.fromMark !== undefined)
      fromTsMs = markMs(marks, input.fromMark);
    if (toTsMs === undefined && input.toMark !== undefined) toTsMs = markMs(marks, input.toMark);
  }
  if (fromTsMs !== undefined && toTsMs !== undefined && toTsMs < fromTsMs) {
    throw invalid("The window is reversed: toTsMs is before fromTsMs.");
  }
  return {
    ...(fromTsMs !== undefined ? { fromTsMs } : {}),
    ...(toTsMs !== undefined ? { toTsMs } : {}),
  };
}

/** Marks of the run, last occurrence of each name wins (as `search_logs` resolves `beforeMark`). */
async function readMarks(runDir: string): Promise<Map<string, number>> {
  const marks = new Map<string, number>();
  let text: string;
  try {
    text = await readFile(join(runDir, "events.jsonl"), "utf8");
  } catch {
    return marks;
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "mark" && typeof event.name === "string" && typeof event.ts === "string") {
        const ms = Date.parse(event.ts);
        if (!Number.isNaN(ms)) marks.set(event.name, ms);
      }
    } catch {
      // a half-written tail line
    }
  }
  return marks;
}

function markMs(marks: ReadonlyMap<string, number>, name: string): number {
  const ms = marks.get(name);
  if (ms === undefined) {
    throw new ToolDomainError(
      "mark_not_found",
      `No mark named "${name}" was recorded in this run.`,
      {
        mark: name,
      },
    );
  }
  return ms;
}
