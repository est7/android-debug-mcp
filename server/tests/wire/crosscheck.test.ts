import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MalformedWireInputError,
  compareProjections,
  fromBaseline,
  fromCapture,
  parseProjections,
} from "../../src/wire/compare.ts";
import { buildSnapshot, writeSnapshot } from "../../src/wire/snapshot.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/wire");
const VENDORED = join(FIXTURES, "baseline_diff.py");
const VONE = join(homedir(), "AndroidStudioProjects/submodulevone.li-refactor-account");
const ORIGINAL = join(VONE, "tools/account-wire-diff/baseline_diff.py");

const python = spawnSync("python3", ["--version"]);
const hasPython = python.status === 0;

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-wire-x-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

interface PythonRun {
  readonly status: number | null;
  readonly counts: Record<string, number>;
  readonly groups: unknown;
}

function runPython(
  script: string,
  baseline: string[],
  capture: string[],
  only: string[] = [],
): PythonRun {
  const out = join(scratch, "report.json");
  const args = [
    script,
    ...baseline.flatMap((b) => ["--baseline", b]),
    ...capture.flatMap((c) => ["--capture", c]),
  ];
  if (only.length > 0) args.push("--only", only.join(","));
  args.push("--out", out);
  const run = spawnSync("python3", args, { encoding: "utf8" });
  if (run.status === 2) throw new Error(`python rejected the input: ${run.stderr}`);
  const report = JSON.parse(readFileSync(out, "utf8")) as { groups: unknown };
  return {
    status: run.status,
    counts: JSON.parse(run.stdout) as Record<string, number>,
    groups: report.groups,
  };
}

function runTs(baseline: string[], capture: string[], only: string[] = []) {
  const set = only.length > 0 ? new Set(only) : undefined;
  const read = (paths: string[]) => paths.map((p) => readFileSync(p, "utf8"));
  const comparison = compareProjections(
    parseProjections(read(baseline), fromBaseline, set),
    parseProjections(read(capture), fromCapture, set),
  );
  // The Python report is JSON: tuples become lists, key order is irrelevant.
  return {
    counts: comparison.counts,
    groups: JSON.parse(JSON.stringify(comparison.groups)) as unknown,
  };
}

describe.skipIf(!hasPython)("cross-check against baseline_diff.py (vendored copy)", () => {
  const baseline = join(FIXTURES, "baseline.legacy.jsonl");
  const capture = join(FIXTURES, "capture.recorder.jsonl");

  it("reports every status exactly as the Python tool does on the shared fixtures", () => {
    const py = runPython(VENDORED, [baseline], [capture]);
    const ts = runTs([baseline], [capture]);
    expect(ts.counts).toEqual(py.counts);
    expect(ts.groups).toEqual(py.groups);
    // The fixture really exercises all five statuses.
    expect(Object.values(ts.counts).every((n) => n > 0)).toBe(true);
    expect(py.status).toBe(1);
  });

  it("agrees under an `only` filter", () => {
    const only = ["/user/login", "/user/check-userid"];
    expect(runTs([baseline], [capture], only)).toEqual(
      (({ counts, groups }) => ({ counts, groups }))(
        runPython(VENDORED, [baseline], [capture], only),
      ),
    );
  });

  it("agrees when the baseline is itself recorder output, with several files", () => {
    const py = runPython(VENDORED, [capture, capture], [capture]);
    const ts = runTs([capture, capture], [capture]);
    expect(ts.counts).toEqual(py.counts);
    expect(ts.groups).toEqual(py.groups);
    expect(ts.counts.MATCH).toBeGreaterThan(0);
  });

  it("agrees on a snapshot made by the snapshot tool, role-bearing on both sides", async () => {
    const snapshot = await buildSnapshot({ files: [join(FIXTURES, "http_synthetic.jsonl")] });
    // Give every record the role a future producer would write, so the Python tool can read it.
    const withRoles = {
      ...snapshot,
      records: snapshot.records.map((r) => ({ ...r, role: "Current" as const })),
    };
    const path = await writeSnapshot({
      dir: scratch,
      label: "snap",
      snapshot: withRoles,
      meta: {},
    });
    const py = runPython(VENDORED, [path], [path]);
    const ts = runTs([path], [path]);
    expect(ts.counts).toEqual(py.counts);
    expect(ts.groups).toEqual(py.groups);
    expect(ts.counts.MATCH).toBe(Object.values(ts.counts).reduce((a, b) => a + b, 0));
  });

  it("both reject a recorder error as malformed input", () => {
    const bad = join(scratch, "bad.jsonl");
    writeFileSync(bad, '{"path":"/user/login","recorderError":"X"}\n');
    expect(() => runPython(VENDORED, [bad], [bad])).toThrow(/rejected/);
    expect(() => runTs([bad], [bad])).toThrow(MalformedWireInputError);
  });
});

// Gated on the real recordings, which live in the Vone checkout and stay out of this repo.
const S16_BASELINE = join(VONE, "docs/projects/account-refactor/evidence/recording/S16.jsonl");
const S16_CAPTURE = join(VONE, ".android-debug-runs/wire/N2.S16.jsonl");
describe.skipIf(
  !hasPython || !existsSync(ORIGINAL) || !existsSync(S16_BASELINE) || !existsSync(S16_CAPTURE),
)("cross-check against the original tool on the S16 legacy-vs-new pair", () => {
  it("matches the original report group for group", () => {
    const py = runPython(ORIGINAL, [S16_BASELINE], [S16_CAPTURE]);
    const ts = runTs([S16_BASELINE], [S16_CAPTURE]);
    expect(ts.counts).toEqual(py.counts);
    expect(ts.groups).toEqual(py.groups);
  });
});
