import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/bootstrap.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

/** The wire tools over DoraLive's log, through the MCP surface: `profile: "dora"` picks its wire. */

let scratch = "";
const open: Array<() => Promise<void>> = [];

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "wire-dora-test", version: "0.0.0-test" });
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
  scratch = mkdtempSync(join(tmpdir(), "adm-wire-dora-"));
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "{}";
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary tool JSON
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, any> };
}

const EMPTY = {
  contentType: null,
  charset: null,
  text: null,
  textBytes: null,
  omittedReason: "no-body",
  preview: null,
  previewBytes: null,
};

/** Two route calls on one path, the second sent twice (a replay); `requestId` differs per build. */
function log(build: string, requestId: string): string {
  const record = (seq: number, controller: string, attempt: number) =>
    JSON.stringify({
      v: 1,
      runId: `run-${build}`,
      seq,
      pid: 1,
      tsMs: 1_800_000_000_000 + seq,
      durationMs: 5,
      method: "POST",
      url: `https://api.example/common-service/api/route?p=android&requestId=${requestId}${seq}&_sign=%3Credacted%3E`,
      path: "/common-service/api/route",
      host: "api.example",
      protocol: "h2",
      heartBeat: false,
      outcome: "ok",
      request: {
        headers: [{ name: "X-Device", value: "android" }],
        params: [
          { name: "p", value: "android" },
          { name: "requestId", value: `${requestId}${seq}` },
          { name: "_sign", value: "<redacted>" },
        ],
        decoded: { build },
        body: EMPTY,
        owner: { role: "Current" },
        encrypted: false,
        route: { controller, method: "list" },
        attempt,
      },
      response: {
        status: 200,
        headers: [],
        body: EMPTY,
        app: { status: null, code: 0, errCode: null, errMsg: null, message: null, ok: true },
      },
      error: null,
    });
  return `${[record(1, "lang", 1), record(2, "gift", 1), record(3, "gift", 2)].join("\n")}\n`;
}

describe("wire_snapshot and wire_diff with the dora profile", () => {
  it("snapshot by route without the replay, then diff names only the changed route", async () => {
    const client = await harness();
    const a = join(scratch, "a.jsonl");
    const b = join(scratch, "b.jsonl");
    writeFileSync(a, log("1", "ra"));
    writeFileSync(b, log("1", "rb"));
    const out = join(scratch, "out");

    const base = await call(client, "android_debug_wire_snapshot", {
      files: [a],
      outDir: out,
      label: "base",
      profile: "dora",
    });
    expect(base.isError).toBe(false);
    expect(base.body).toMatchObject({ profile: "dora", written: 2, replays: 1 });
    const records = readFileSync(base.body.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records.map((r) => r.route)).toEqual(["lang/list", "gift/list"]);

    const same = await call(client, "android_debug_wire_snapshot", {
      files: [b],
      outDir: out,
      label: "same",
      profile: "dora",
    });
    const diff = await call(client, "android_debug_wire_diff", {
      baseline: base.body.path,
      capture: same.body.path,
      profile: "dora",
    });
    expect(diff.isError).toBe(false);
    expect(diff.body.profile).toBe("dora");
    expect(diff.body.counts).toMatchObject({ MATCH: 2, CHANGED: 0, DUPLICATE: 0 });

    const poppo = await call(client, "android_debug_wire_diff", {
      baseline: base.body.path,
      capture: same.body.path,
    });
    expect(poppo.body.profile).toBeNull();
    expect(poppo.body.counts.CHANGED).toBe(2);
  });

  it("an unknown profile is an argument error", async () => {
    const client = await harness();
    const a = join(scratch, "a.jsonl");
    writeFileSync(a, log("1", "ra"));
    const result = await call(client, "android_debug_wire_snapshot", {
      files: [a],
      outDir: join(scratch, "out"),
      profile: "nope",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.body)).toContain("invalid_argument");
  });
});
