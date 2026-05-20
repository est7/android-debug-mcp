import { spawnSync } from "node:child_process";

export interface GitInfo {
  /** `HEAD` commit SHA, or null when the directory is not a git checkout. */
  readonly sha: string | null;
  /** true if the working tree has uncommitted changes; null when unknown. */
  readonly dirty: boolean | null;
}

/**
 * Best-effort git provenance for the run's `projectRoot`. Recorded into
 * `metadata.json` so a captured run can be tied back to a code revision.
 *
 * Never throws: a missing git binary, a non-repo directory, or a detached
 * weird state all degrade to `{ sha: null, dirty: null }`. Uses
 * `node:child_process` (not `Bun.spawnSync`) so it behaves the same under
 * vitest's Node runtime and `bun run`.
 */
export function getGitInfo(projectRoot: string): GitInfo {
  const sha = gitCapture(projectRoot, ["rev-parse", "HEAD"]);
  if (sha === null) return { sha: null, dirty: null };
  const status = gitCapture(projectRoot, ["status", "--porcelain"]);
  return {
    sha,
    dirty: status === null ? null : status.length > 0,
  };
}

function gitCapture(projectRoot: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", projectRoot, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
}
