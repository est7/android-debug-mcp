import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "../../session/manager.ts";
import { resolveRunDir } from "../../store/locate.ts";
import {
  type GroupReport,
  MalformedWireInputError,
  compareProjections,
  fromBaseline,
  fromCapture,
  parseProjections,
} from "../../wire/compare.ts";
import { WIRE_SUBDIR, assertLabel } from "../../wire/snapshot.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, runIdInput } from "./_shared.ts";

const pathList = z.union([
  z.string().min(1).max(1024),
  z.array(z.string().min(1).max(1024)).min(1).max(16),
]);

const inputSchema = z
  .object({
    baseline: pathList,
    capture: pathList,
    runId: runIdInput.optional(),
    only: z
      .array(
        z
          .string()
          .min(2)
          .max(256)
          .refine((p) => p.startsWith("/"), "paths must start with '/'"),
      )
      .min(1)
      .max(64)
      .optional(),
    groupBy: z.array(z.string().min(1).max(64)).max(8).optional(),
    maxGroups: z.number().int().min(1).max(200).default(40),
    reportLabel: z.string().min(1).max(64).optional(),
  })
  .strict();

const statusCounts = z
  .object({
    MATCH: z.number().int(),
    CHANGED: z.number().int(),
    MISSING: z.number().int(),
    EXTRA: z.number().int(),
    DUPLICATE: z.number().int(),
  })
  .strict();

const outputSchema = z
  .object({
    counts: statusCounts,
    groupsTotal: z.number().int(),
    roleCompared: z.boolean(),
    baselineRecords: z.number().int(),
    captureRecords: z.number().int(),
    groups: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    reportPath: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const description = [
  "Compare a candidate build's request parameters with a reference build's, grouped by endpoint, and report what changed. A port of the account wire comparator (`baseline_diff.py`): same normalization, grouping and statuses.",
  "",
  "Use when: two `android_debug_wire_snapshot` outputs (or a legacy recording and a snapshot) must be checked for parity: did the new build send the same requests with the same parameters as the old one?",
  "Args: `baseline` and `capture` (a JSONL path or a list of them; relative paths resolve inside `<runDir>/wire/` when `runId` is given; the baseline may also be a legacy recording with `projection.wire`); `only` (exact request paths to compare); `groupBy` (fields that split one path into groups; default `type`, `login_type`, `use`); `maxGroups` (non-MATCH groups returned, default 40); `runId` + `reportLabel` (write the full report to `<runDir>/wire/<reportLabel>.diff.json`).",
  "Returns: `{counts:{MATCH,CHANGED,MISSING,EXTRA,DUPLICATE}, groupsTotal, roleCompared, baselineRecords, captureRecords, groups[], truncated, reportPath?, warnings?}`. `groups` holds only non-MATCH groups with normalized projections (credentials `<r>`, build / locale / device / sign / time values `*`, no raw values): `CHANGED` has `onlyBaseline`/`onlyCapture`, `DUPLICATE` has `repeated[{times,baselineTimes,projection}]`, `MISSING`/`EXTRA` have `projections`. Statuses: MATCH same projections; CHANGED different ones; MISSING only in the baseline; EXTRA only in the capture; DUPLICATE the capture sent a projection more often than the baseline (and more than once). Owner role is compared, a POST query's order is not, and when a record has no role the role is left out for both sides (`roleCompared:false`).",
  "Errors: `invalid_argument` for malformed or unreadable input (a line that is not JSON, a recorder error, an unknown role, a missing file) or a relative path without `runId`; `run_missing` for an unknown runId.",
].join("\n");

export function registerWireDiff(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_wire_diff",
    {
      title: "Diff request parameters",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (input.reportLabel !== undefined) {
        assertLabel(input.reportLabel);
        if (input.runId === undefined) {
          throw new ToolDomainError(
            "invalid_argument",
            "`reportLabel` needs a `runId` to write into.",
          );
        }
      }
      const runDir =
        input.runId !== undefined ? await resolveRunDir(manager, input.runId) : undefined;
      const resolve = (p: string): string => {
        if (isAbsolute(p)) return p;
        if (runDir === undefined) {
          throw new ToolDomainError("invalid_argument", `Relative path needs a runId: ${p}`);
        }
        return join(runDir, WIRE_SUBDIR, p);
      };
      const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

      const only = input.only !== undefined ? new Set(input.only) : undefined;
      let comparison: ReturnType<typeof compareProjections>;
      let baselineRecords: number;
      let captureRecords: number;
      try {
        const baseline = parseProjections(
          await readAll(asList(input.baseline).map(resolve)),
          fromBaseline,
          only,
        );
        const capture = parseProjections(
          await readAll(asList(input.capture).map(resolve)),
          fromCapture,
          only,
        );
        baselineRecords = baseline.length;
        captureRecords = capture.length;
        comparison = compareProjections(baseline, capture, {
          ...(input.groupBy !== undefined ? { discriminators: input.groupBy } : {}),
        });
      } catch (err) {
        if (err instanceof MalformedWireInputError) {
          throw new ToolDomainError("invalid_argument", `Malformed input: ${err.message}`);
        }
        throw err;
      }

      const warnings: string[] = [];
      if (!comparison.roleCompared) {
        warnings.push("some records have no role: role was not compared.");
      }
      if (baselineRecords === 0 || captureRecords === 0) {
        warnings.push(
          `${baselineRecords === 0 ? "baseline" : "capture"} has no records (check \`only\` and the files).`,
        );
      }

      let reportPath: string | undefined;
      if (input.reportLabel !== undefined && runDir !== undefined) {
        const dir = join(runDir, WIRE_SUBDIR);
        await mkdir(dir, { recursive: true });
        reportPath = join(dir, `${input.reportLabel}.diff.json`);
        const tmp = `${reportPath}.${process.pid}.tmp`;
        const report = {
          schemaVersion: 1,
          counts: comparison.counts,
          roleCompared: comparison.roleCompared,
          groups: comparison.groups,
        };
        await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        await rename(tmp, reportPath);
      }

      const { shown, truncated } = fitGroups(
        comparison.groups.filter((g) => g.status !== "MATCH"),
        input.maxGroups,
      );
      if (truncated) {
        warnings.push(
          reportPath === undefined
            ? "groups were truncated; pass runId + reportLabel to keep the full report."
            : "groups were truncated; the full report is at reportPath.",
        );
      }
      return ok({
        counts: comparison.counts,
        groupsTotal: comparison.groups.length,
        roleCompared: comparison.roleCompared,
        baselineRecords,
        captureRecords,
        groups: shown as unknown as Record<string, unknown>[],
        truncated,
        ...(reportPath !== undefined ? { reportPath } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );
}

async function readAll(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    try {
      out.push(await readFile(path, "utf8"));
    } catch {
      throw new MalformedWireInputError(`cannot read ${path}`);
    }
  }
  return out;
}

/** Keep the response well under the transport limit: at most `maxGroups` groups and ~18k characters. */
function fitGroups(
  groups: readonly GroupReport[],
  maxGroups: number,
): { shown: GroupReport[]; truncated: boolean } {
  const budget = 18_000;
  const shown: GroupReport[] = [];
  let size = 0;
  for (const group of groups) {
    const length = JSON.stringify(group).length;
    if (shown.length >= maxGroups || (shown.length > 0 && size + length > budget)) {
      return { shown, truncated: true };
    }
    shown.push(group);
    size += length;
  }
  return { shown, truncated: false };
}
