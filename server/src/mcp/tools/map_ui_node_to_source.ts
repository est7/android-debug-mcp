import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactValue } from "../../redact/redact.ts";
import type { SessionManager } from "../../session/manager.ts";
import { SOURCE_CANDIDATE_KINDS } from "../../source/candidate.ts";
import {
  CONFIDENCE_SIGNALS,
  type Confidence,
  evaluateConfidence,
} from "../../source/confidence.ts";
import { requireProjectRoot } from "../../source/project_root.ts";
import { type RecipeResult, parseResourceId, resolveCandidates } from "../../source/recipe.ts";
import { AppendStream } from "../../store/jsonl.ts";
import { resolveRunDir } from "../../store/locate.ts";
import { readMetadata } from "../../store/metadata.ts";
import { registerDebugTool } from "../register.ts";
import { ok, runIdInput } from "./_shared.ts";

/**
 * `android_debug_map_ui_node_to_source` — the v2-A chain-M tool.
 *
 * Maps a tapped UI node (an `android_debug_tap_node` anchor) back to the
 * source that owns it. Device-independent (design lock Q6): it resolves the
 * run folder from disk, reads the persisted `projectRoot`, runs the
 * ViewBinding `rg` recipe + the confidence model, and records the call as a
 * `source_mapping` event. It works on an active OR a long-finalized run, and
 * never backfills candidates into the append-only `tap_node` event.
 */

// NOTE: this `nodeSchema` mirrors the one in `tap_node.ts` — the agent feeds a
// `tap_node` result straight into this tool. The Node shape is frozen by
// design lock Q8; a future tidy could lift a single shared schema.
const boundsSchema = z
  .object({
    left: z.number().int(),
    top: z.number().int(),
    right: z.number().int(),
    bottom: z.number().int(),
  })
  .strict();

const nodeSchema = z
  .object({
    resourceId: z.string().nullable(),
    class: z.string(),
    package: z.string(),
    bounds: boundsSchema.nullable(),
    index: z.number().int().nullable(),
    clickable: z.boolean(),
    focusable: z.boolean(),
  })
  .strict();

const candidateSchema = z
  .object({
    file: z.string(),
    line: z.number().int(),
    kind: z.enum(SOURCE_CANDIDATE_KINDS),
    text: z.string(),
  })
  .strict();

const MIN_CONFIDENCE_VALUES = ["medium", "high"] as const;
type MinConfidence = (typeof MIN_CONFIDENCE_VALUES)[number];

const SOURCE_MAPPING_WARNINGS = ["confidence_below_min"] as const;

const inputSchema = z
  .object({
    runId: runIdInput,
    anchorNode: nodeSchema.nullable(),
    foregroundActivity: z.string().nullable(),
    ancestorChain: z.array(nodeSchema),
    minConfidence: z.enum(MIN_CONFIDENCE_VALUES).optional(),
    top: z.number().int().min(1, "top must be >= 1").max(100, "top must be <= 100").optional(),
  })
  .strict();

const outputSchema = z
  .object({
    confidence: z.enum(["high", "medium", "low", "none"]),
    reason: z.string(),
    signals: z.array(z.enum(CONFIDENCE_SIGNALS)),
    candidates: z.array(candidateSchema),
    warnings: z.array(z.enum(SOURCE_MAPPING_WARNINGS)).optional(),
  })
  .strict();

type SourceMappingResult = z.input<typeof outputSchema>;

const description = [
  "Map a tapped UI node back to the source that owns it — layout id declaration, screen owner, and code references.",
  "",
  "Use when: after `android_debug_tap_node` returned an `anchorNode`, you want the file:line in the project source that declares or handles that element. Device-independent — it runs against the recorded run plus the project source, so it works on a finalized run too.",
  "Args: `runId` (an active or finalized run); `anchorNode` (the `tap_node` anchor, or null); `foregroundActivity` (the `tap_node` foreground activity, or null); `ancestorChain` (the `tap_node` ancestor chain); optional `minConfidence` (`medium` or `high`) gates the candidate list by the overall graded verdict; optional `top` (1-100) returns only the first N candidates after that gate.",
  'Returns: `{confidence, reason, signals[], candidates[], warnings?}` — a graded verdict (`high`/`medium`/`low`/`none`) with machine-readable signals and the source `{file, line, kind, text}` candidates in deterministic order. When `minConfidence` is not met, `candidates` is empty and `warnings:["confidence_below_min"]`; the verdict fields still explain what was found. A `source_mapping` event is appended to the run.',
  "Errors: `run_missing` for an unknown runId; `project_root_missing` when the run was not started inside a git checkout (there is no source tree to search); `rg_not_found` when the ripgrep binary is missing; `search_timed_out` when a source search exceeds its time budget.",
].join("\n");

export function registerMapUiNodeToSource(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_map_ui_node_to_source",
    {
      title: "Map a UI node to its source",
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
      const runDir = await resolveRunDir(manager, input.runId);
      const metadata = await readMetadata(runDir);

      const anchorResourceId = input.anchorNode?.resourceId ?? null;
      const parsed = anchorResourceId !== null ? parseResourceId(anchorResourceId) : null;
      // Only an app-package resource-id is a real source anchor (design lock
      // Q4). A null / framework / foreign anchor needs no `rg` search — and so
      // needs no projectRoot: it is a soft `none`, never a hard error. Q5's
      // `project_root_missing` applies only when a search would actually run.
      const isAppAnchor = parsed !== null && parsed.pkg === metadata.packageName;
      let recipe: RecipeResult = { candidates: [], commands: [] };
      if (isAppAnchor && anchorResourceId !== null) {
        // Q5: the source root is the persisted projectRoot, nothing else.
        const projectRoot = requireProjectRoot(metadata);
        recipe = await resolveCandidates(anchorResourceId, projectRoot);
      }

      const verdict = evaluateConfidence({
        candidates: recipe.candidates,
        anchorNode: input.anchorNode,
        foregroundActivity: input.foregroundActivity,
        ancestorChain: input.ancestorChain,
        sessionPackage: metadata.packageName,
      });

      const baseResult = {
        confidence: verdict.confidence,
        reason: verdict.reason,
        signals: verdict.signals,
        candidates: recipe.candidates,
      };
      const result = applyCandidateOptions(baseResult, {
        ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
        ...(input.top !== undefined ? { top: input.top } : {}),
      });

      // Record the call: one `source_mapping` event + one `commands.jsonl`
      // line per `rg` invocation. The run may be active or long finalized, so
      // append directly — `AppendStream` is O_APPEND, safe across handles
      // (see store/jsonl.ts) — never through a live session stream.
      const ts = new Date().toISOString();
      await appendRecords(join(runDir, "events.jsonl"), [
        redactValue({
          type: "source_mapping",
          anchorNode: input.anchorNode,
          foregroundActivity: input.foregroundActivity,
          ...(input.minConfidence !== undefined ? { minConfidence: input.minConfidence } : {}),
          ...(input.top !== undefined ? { top: input.top } : {}),
          ...result,
          ts,
        }),
      ]);
      await appendRecords(
        join(runDir, "commands.jsonl"),
        recipe.commands.map((rg) => redactValue({ tool: "map_ui_node_to_source", rg, ts })),
      );

      return ok(result);
    },
  );
}

interface CandidateOptions {
  readonly minConfidence?: MinConfidence;
  readonly top?: number;
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function applyCandidateOptions(
  result: SourceMappingResult,
  opts: CandidateOptions,
): SourceMappingResult {
  if (
    opts.minConfidence !== undefined &&
    CONFIDENCE_RANK[result.confidence] < CONFIDENCE_RANK[opts.minConfidence]
  ) {
    return { ...result, candidates: [], warnings: ["confidence_below_min"] };
  }
  if (opts.top !== undefined) {
    return { ...result, candidates: result.candidates.slice(0, opts.top) };
  }
  return result;
}

/** Append records to a run's JSONL file directly (the run has no live session). */
async function appendRecords(path: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  const stream = await AppendStream.open(path);
  try {
    for (const record of records) {
      await stream.append(record);
    }
  } finally {
    await stream.close();
  }
}
