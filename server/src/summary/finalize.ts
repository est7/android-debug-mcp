import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type RunData, collectRunData } from "./collect.ts";
import { renderSummary } from "./render.ts";

export const SUMMARY_FILENAME = "summary.md";

export interface SummaryResult {
  readonly markdown: string;
  readonly data: RunData;
}

/**
 * Collect a run's evidence, render the Markdown report, and write `summary.md`
 * into the run folder. Shared by `get_run_summary` (which also returns the
 * data) and `stop_session` (which calls it best-effort on teardown). The Phase
 * 8 orphan-recovery path will call it too.
 */
export async function finalizeSummary(runDir: string): Promise<SummaryResult> {
  const data = await collectRunData(runDir);
  const markdown = renderSummary(data);
  await writeFile(join(runDir, SUMMARY_FILENAME), markdown, "utf8");
  return { markdown, data };
}
