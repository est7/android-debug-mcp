import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/bootstrap.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";
import { createRunDir } from "../../src/store/run.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/wire");
const HTTP = join(FIXTURES, "http_synthetic.jsonl");

let scratch = "";
const open: Array<() => Promise<void>> = [];

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "wire-test", version: "0.0.0-test" });
  registerAllTools(server, new SessionManager());
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  open.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-wire-tools-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = join(scratch, "runs");
  resetPathsCache();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

type Args = Record<string, unknown>;
async function call(client: Client, name: string, args: Args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "{}";
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary tool JSON
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, any> };
}

/** A finished run folder whose evidence/poppo_http already holds the synthetic log. */
async function finishedRun(runId: string, marks: Array<{ name: string; ts: string }> = []) {
  const folder = await createRunDir({
    runRoot: join(scratch, "runs"),
    runRootSource: "explicit",
    projectRoot: null,
    packageName: "com.example.app",
    userId: 0,
    runId,
    deviceSerial: "SER",
    startedAt: new Date(0),
  });
  await folder.closeStreams();
  const evidence = join(folder.runDir, "evidence", "poppo_http");
  mkdirSync(evidence, { recursive: true });
  copyFileSync(HTTP, join(evidence, "http_2026-10-13_0.jsonl"));
  writeFileSync(
    join(folder.runDir, "events.jsonl"),
    marks.map((m) => JSON.stringify({ type: "mark", ...m })).join("\n") +
      (marks.length > 0 ? "\n" : ""),
  );
  return folder.runDir;
}

describe("android_debug_wire_snapshot", () => {
  it("snapshots local files into outDir without a run", async () => {
    const client = await harness();
    const outDir = join(scratch, "out");
    const { isError, body } = await call(client, "android_debug_wire_snapshot", {
      files: [HTTP],
      outDir,
      label: "cand",
    });
    expect(isError).toBe(false);
    expect(body.path).toBe(join(outDir, "cand.jsonl"));
    expect(body.written).toBe(9);
    expect(body.linesSkipped).toBe(1);
    expect(body.aliases).toEqual({ uid: 2, phone: 3, email: 1 });
    expect(body.warnings?.join(" ")).not.toContain("no record carries");
    expect(readFileSync(body.path, "utf8")).not.toContain("hunter2");
  });

  it("snapshots a finished run into <runDir>/wire and windows by marks", async () => {
    const runDir = await finishedRun("2026-10-13T00-00-00.000Z_AAAA", [
      { name: "start", ts: new Date(2000).toISOString() },
      { name: "end", ts: new Date(4000).toISOString() },
    ]);
    const client = await harness();
    const { isError, body } = await call(client, "android_debug_wire_snapshot", {
      runId: "2026-10-13T00-00-00.000Z_AAAA",
      label: "window",
      fromMark: "start",
      toMark: "end",
      only: ["/user/info", "/user/login"],
    });
    expect(isError).toBe(false);
    expect(body.path).toBe(join(runDir, "wire", "window.jsonl"));
    expect(body.window).toEqual({ fromTsMs: 2000, toTsMs: 4000 });
    expect(body.byPath).toEqual({ "/user/info": 1, "/user/login": 1 });
    expect(existsSync(join(runDir, "wire", "window.snapshot.json"))).toBe(true);
  });

  it("reports an unknown mark, a bad label and missing inputs as domain errors", async () => {
    await finishedRun("2026-10-13T00-00-00.000Z_BBBB");
    const client = await harness();
    const mark = await call(client, "android_debug_wire_snapshot", {
      runId: "2026-10-13T00-00-00.000Z_BBBB",
      fromMark: "nope",
    });
    expect([mark.isError, mark.body.error]).toEqual([true, "mark_not_found"]);
    const label = await call(client, "android_debug_wire_snapshot", {
      files: [HTTP],
      outDir: scratch,
      label: "../x",
    });
    expect([label.isError, label.body.error]).toEqual([true, "invalid_argument"]);
    const none = await call(client, "android_debug_wire_snapshot", {});
    expect([none.isError, none.body.error]).toEqual([true, "invalid_argument"]);
    const relative = await call(client, "android_debug_wire_snapshot", {
      files: ["x.jsonl"],
      outDir: scratch,
    });
    expect([relative.isError, relative.body.error]).toEqual([true, "invalid_argument"]);
  });
});

describe("android_debug_wire_diff", () => {
  it("compares two snapshots of a run, writes the report, and returns normalized projections only", async () => {
    const runDir = await finishedRun("2026-10-13T00-00-00.000Z_CCCC");
    const client = await harness();
    const runId = "2026-10-13T00-00-00.000Z_CCCC";
    await call(client, "android_debug_wire_snapshot", { runId, label: "ref" });
    await call(client, "android_debug_wire_snapshot", {
      runId,
      label: "cand",
      only: ["/user/info", "/user/login"],
    });

    const { isError, body } = await call(client, "android_debug_wire_diff", {
      runId,
      baseline: "ref.jsonl",
      capture: "cand.jsonl",
      reportLabel: "ref-vs-cand",
    });
    expect(isError).toBe(false);
    // Snapshots carry no role (one record has one): role is left out.
    expect(body.roleCompared).toBe(false);
    expect(body.counts.MATCH).toBe(2);
    expect(body.counts.MISSING).toBe(5);
    expect(body.groups.every((g: { status: string }) => g.status === "MISSING")).toBe(true);
    expect(existsSync(body.reportPath)).toBe(true);
    expect(body.reportPath).toBe(join(runDir, "wire", "ref-vs-cand.diff.json"));
    const text = JSON.stringify(body);
    for (const raw of ["hunter2", "15550001111", "a@example.test", "dev-smei-1", "cmFuZG9t"]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  it("reads a legacy baseline and honours only / groupBy / maxGroups", async () => {
    const client = await harness();
    const base = join(FIXTURES, "baseline.legacy.jsonl");
    const capture = join(FIXTURES, "capture.recorder.jsonl");
    const all = await call(client, "android_debug_wire_diff", { baseline: base, capture });
    expect(all.body.counts).toEqual({ MATCH: 3, CHANGED: 5, MISSING: 1, EXTRA: 1, DUPLICATE: 1 });
    expect(all.body.groupsTotal).toBe(11);
    expect(all.body.groups).toHaveLength(8);

    const only = await call(client, "android_debug_wire_diff", {
      baseline: base,
      capture,
      only: ["/user/login"],
    });
    expect(only.body.counts).toEqual({ MATCH: 1, CHANGED: 1, MISSING: 0, EXTRA: 0, DUPLICATE: 0 });

    const capped = await call(client, "android_debug_wire_diff", {
      baseline: base,
      capture,
      maxGroups: 2,
    });
    expect(capped.body.groups).toHaveLength(2);
    expect(capped.body.truncated).toBe(true);

    const merged = await call(client, "android_debug_wire_diff", {
      baseline: base,
      capture,
      only: ["/user/login"],
      groupBy: [],
    });
    expect(merged.body.groupsTotal).toBe(1);
  });

  it("rejects unreadable input, a recorder error and relative paths without a run", async () => {
    const client = await harness();
    const bad = join(scratch, "bad.jsonl");
    writeFileSync(bad, '{"path":"/user/login","recorderError":"X"}\n');
    for (const args of [
      { baseline: bad, capture: bad },
      { baseline: join(scratch, "missing.jsonl"), capture: bad },
      { baseline: "rel.jsonl", capture: bad },
    ]) {
      const r = await call(client, "android_debug_wire_diff", args);
      expect([r.isError, r.body.error]).toEqual([true, "invalid_argument"]);
    }
  });
});
