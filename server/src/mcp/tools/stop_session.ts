import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sealEvidenceSource } from "../../evidence/runtime.ts";
import { createLogger } from "../../mcp/log.ts";
import type { SessionManager } from "../../session/manager.ts";
import type { Session } from "../../session/session.ts";
import { RunStatusSchema, readMetadata } from "../../store/metadata.ts";
import { finalizeSummary } from "../../summary/finalize.ts";
import { registerDebugTool } from "../register.ts";
import { ok, runIdInput } from "./_shared.ts";

const log = createLogger("android-debug-mcp:stop_session");

const inputSchema = z
  .object({
    runId: runIdInput.optional(),
  })
  .strict();

const outputSchema = z
  .object({
    runId: z.string(),
    runDir: z.string(),
    status: RunStatusSchema,
    crashFound: z.boolean(),
    summary: z.string(),
  })
  .strict();

const description = [
  "Stop an active debug session: finalize its metadata, flush and close the run's jsonl streams, and release the global lock.",
  "",
  "Use when: a debug run is complete and the agent wants the run sealed on disk.",
  "Args: `runId` — optional; may be omitted only when exactly one session is active.",
  "Returns: `{runId, runDir, status, crashFound, summary}`. `summary` is a short stub in v1 Phase 3; the full report comes from `android_debug_get_run_summary`.",
  "Errors: `no_active_session` when nothing is running; `ambiguous_active_session` when `runId` is omitted but two or more sessions are active; `run_missing` when the given `runId` is unknown.",
].join("\n");

export function registerStopSession(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_stop_session",
    {
      title: "Stop debug session",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = manager.resolveForStop(input.runId);
      // v2-G Phase 3 (Q5+ + codex amendment #1): seal-pull every declared
      // evidence source before tearing down. The active file's mtime almost
      // certainly grew since the last lazy pull; a stale local tail would
      // make `collect_bundle` (Phase 5) miss records in the final archive.
      // Post-session `search_evidence` is NOT supported (the tool requires
      // an active session), so the bundle is the only consumer that depends
      // on this final tail.
      //
      // Seal is best-effort: a failing source must NOT block session
      // teardown (the run is over; manager.stop must complete to free the
      // tuple lock). Each per-source failure is logged + recorded as an
      // `evidence_seal_failed` event for postmortem visibility.
      await sealAllSources(session);
      // The `session_stop` event + teardown both happen inside manager.stop(),
      // where the event write is best-effort so it can never block finalize.
      await manager.stop(session);
      const finalMeta = await readMetadata(session.runDir);
      // Write summary.md best-effort: the run is already sealed, so a render
      // failure must not fail the stop — get_run_summary regenerates it anyway.
      await finalizeSummary(session.runDir).catch(() => undefined);
      // Report the run's ACTUAL terminal status — a session degraded by a
      // device disconnect finalizes `degraded`, and `stop_session` must not
      // flatten that to `stopped` (it would diverge from metadata /
      // get_run_summary).
      return ok({
        runId: session.runId,
        runDir: session.runDir,
        status: finalMeta.status,
        crashFound: finalMeta.crashFound,
        summary: `Session ${session.runId} stopped (status=${finalMeta.status}). Full report: android_debug_get_run_summary.`,
      });
    },
  );
}

/**
 * Normalize an arbitrary thrown value into a `{code, message}` pair suitable
 * for the `evidence_seal_failed` event payload. `ToolDomainError` /
 * `AdbError` (Phase 4) carry `code` natively; bare `Error` falls back to a
 * generic `"seal_failed"` code so the postmortem agent can still branch
 * structurally.
 */
function describeError(err: unknown): { code: string; message: string } {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (typeof code === "string") return { code, message };
  }
  if (err instanceof Error) return { code: "seal_failed", message: err.message };
  return { code: "seal_failed", message: String(err) };
}

/**
 * Iterate every evidence source in the session's profile and seal-pull. Each
 * source's pull goes through {@link sealEvidenceSource} which only writes to
 * `<runDir>/evidence/<source>/` + the mtime cache; no events are written by
 * the runtime itself (Phase 3 contract: events live at the handler boundary).
 *
 * On success, append one `evidence_pulled` event per source that actually
 * pulled bytes. On failure, append one `evidence_seal_failed` event so the
 * postmortem path can see what was missed; the failure does NOT propagate —
 * the run must always be able to close cleanly.
 */
async function sealAllSources(session: Session): Promise<void> {
  if (session.profile === null) return;
  if (session.profile.evidenceSources.length === 0) return;
  for (const source of session.profile.evidenceSources) {
    try {
      const pulls = await sealEvidenceSource({
        source,
        ctx: session.evidenceContext(),
        runDir: session.runDir,
      });
      if (pulls.length > 0) {
        await session
          .appendEvent({
            type: "evidence_pulled",
            source: source.id,
            trigger: "seal",
            files: pulls.map((p) => basename(p.localPath)),
          })
          .catch((err) => {
            log.warn("evidence_pulled (seal) append failed; continuing teardown", {
              runId: session.runId,
              source: source.id,
              error: String(err),
            });
          });
      }
    } catch (err) {
      const structured = describeError(err);
      log.warn("evidence source seal failed; continuing teardown", {
        runId: session.runId,
        source: source.id,
        ...structured,
      });
      await session
        .appendEvent({
          type: "evidence_seal_failed",
          source: source.id,
          // Structured per codex Phase 3 audit (F): Phase 4 will surface
          // `AdbError` here, and a `{code, message}` shape lets postmortem
          // tooling branch on `code` without re-parsing a string.
          error: structured,
        })
        .catch(() => undefined);
    }
  }
}
