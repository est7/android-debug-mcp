import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createBundle } from "../../bundle/bundle.ts";
import { EVIDENCE_SUBDIR } from "../../evidence/paths.ts";
import { findBuiltinProfile } from "../../profile/registry.ts";
import type { Profile } from "../../profile/types.ts";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import { readMetadata } from "../../store/metadata.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    logs: z.enum(["none", "redacted", "raw"]).default("none"),
    acknowledgeUnredacted: z.boolean().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    bundlePath: z.string(),
    byteSize: z.number().int(),
    logs: z.enum(["none", "redacted", "raw"]),
  })
  .strict();

const description = [
  "Package a debug run's folder into a `.tar.gz` archive for sharing or archival.",
  "",
  "Use when: a run is complete and the agent wants a single transferable artifact of its evidence.",
  "Args: `runId`; `logs` — `none` (default; no logcat), `redacted` (logcat.jsonl with credentials scrubbed), or `raw` (verbatim logcat.jsonl + logcat.raw.txt); `acknowledgeUnredacted` — required `true` when `logs` is `raw`. NOTE: `acknowledgeUnredacted` only governs logcat — v2-G evidence (`evidence/<source>/*.jsonl`) is ALWAYS redacted per Q6, with no opt-out.",
  "Returns: `{bundlePath, byteSize, logs}` — the archive lands in `<runRoot>/bundles/`.",
  "Errors: `run_missing` for an unknown runId; `confirmation_required` when `logs` is `raw` without `acknowledgeUnredacted: true` (the unredacted-export leak gate, § C-4); `evidence_redaction_unavailable` when the run has `evidence/` dirs but the profile / source can't be resolved for redaction.",
].join("\n");

export function registerCollectBundle(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_collect_bundle",
    {
      title: "Collect run bundle",
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
      // § C-4 leak gate: a raw (unredacted) export must be explicitly acknowledged.
      if (input.logs === "raw" && input.acknowledgeUnredacted !== true) {
        throw new ToolDomainError(
          "confirmation_required",
          'logs:"raw" exports unredacted logcat — pass acknowledgeUnredacted:true to confirm, or use logs:"redacted".',
          { runId: input.runId },
        );
      }
      const runDir = await resolveRunDir(manager, input.runId);
      const metadata = await readMetadata(runDir);
      const profile = await resolveProfileForRedaction(runDir, metadata.profile?.name ?? null);
      const result = await createBundle({
        runDir,
        runId: input.runId,
        bundlesDir: join(metadata.runRoot, "bundles"),
        logs: input.logs,
        profile,
      });
      return ok({
        bundlePath: result.bundlePath,
        byteSize: result.byteSize,
        logs: result.logs,
      });
    },
  );
}

/**
 * Phase 5 Q6 enforcement: resolve the run's profile for evidence redaction
 * before passing it to `createBundle`. Three failure modes throw
 * `evidence_redaction_unavailable` (codex Phase 5 (i) review β):
 *
 *   1. Profile name in metadata but unresolvable in the built-in registry
 *      (profile renamed or removed in a code update since the run finalized).
 *   2. `metadata.profile == null` but the run has `evidence/<id>/` dirs on
 *      disk (pre-Phase-3 run produced on a Phase-3+ binary, or hand-tampered
 *      run folder). Treat as hard error — vanilla-path skip would ship the
 *      evidence raw, which is exactly what Q6 prevents.
 *   3. Resolved profile loaded fine, but an `evidence/<id>/` dir exists for
 *      an `id` the profile does NOT declare (orphan source from an older
 *      profile version; codex δ-answer was emphatic about not silently
 *      dropping the dir — that hides evidence loss).
 *
 * When the run has no `evidence/` dir at all, profile null is fine (vanilla
 * pre-v2-G run); return null.
 */
async function resolveProfileForRedaction(
  runDir: string,
  profileName: string | null,
): Promise<Profile | null> {
  const evidenceSourceIds = await listEvidenceSourceIds(runDir);
  if (evidenceSourceIds.length === 0) {
    // No evidence on disk → no redaction needed; profile can be null.
    return profileName === null ? null : (findBuiltinProfile(profileName) ?? null);
  }
  if (profileName === null) {
    throw new ToolDomainError(
      "evidence_redaction_unavailable",
      `run has evidence/${evidenceSourceIds[0]}/ but metadata.profile is null; cannot redact at bundle export.`,
      { profileName: null, sourceId: evidenceSourceIds[0] ?? null },
    );
  }
  const profile = findBuiltinProfile(profileName);
  if (profile === null) {
    throw new ToolDomainError(
      "evidence_redaction_unavailable",
      `metadata.profile names '${profileName}' but no such built-in profile exists; cannot redact evidence at bundle export.`,
      { profileName, sourceId: null },
    );
  }
  const declaredIds = new Set(profile.evidenceSources.map((s) => s.id));
  for (const id of evidenceSourceIds) {
    if (!declaredIds.has(id)) {
      throw new ToolDomainError(
        "evidence_redaction_unavailable",
        `evidence/${id}/ exists on disk but profile '${profileName}' declares no source with that id; cannot redact at bundle export.`,
        { profileName, sourceId: id },
      );
    }
  }
  return profile;
}

/** Read `<runDir>/evidence/` subdir names. Returns `[]` when the dir does not exist. */
async function listEvidenceSourceIds(runDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(runDir, EVIDENCE_SUBDIR), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}
