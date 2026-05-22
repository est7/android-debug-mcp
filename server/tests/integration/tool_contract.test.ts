import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/bootstrap.ts";
import { ANDROID_DEBUG_TOOL_NAMES } from "../../src/mcp/constants.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

let scratch = "";
const open: Array<() => Promise<void>> = [];

async function harness(): Promise<Client> {
  const server = new McpServer({ name: "tool-contract-test", version: "0.0.0-test" });
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
  scratch = mkdtempSync(join(tmpdir(), "adm-contract-"));
  process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
  resetPathsCache();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
  delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
  resetPathsCache();
  rmSync(scratch, { recursive: true, force: true });
});

function errorOf(result: unknown): string {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "{}";
  return (JSON.parse(text) as { error?: string }).error ?? "";
}

describe("v1 tool inventory", () => {
  it("registers exactly the 18 tools of ANDROID_DEBUG_TOOL_NAMES", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(18);
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(ANDROID_DEBUG_TOOL_NAMES));
  });

  it("every registered tool carries a description and the four annotation hints", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      const a = tool.annotations ?? {};
      expect(typeof a.readOnlyHint).toBe("boolean");
      expect(typeof a.destructiveHint).toBe("boolean");
      expect(typeof a.idempotentHint).toBe("boolean");
      expect(typeof a.openWorldHint).toBe("boolean");
    }
  });

  // Every tool that reaches an adb subprocess can, after Phase 10, return the
  // `adb_command_failed` domain envelope — so its advertised `Errors:` line
  // must say so. The description IS the client-visible contract; this test
  // stops an adb-backed tool from silently omitting it.
  it("every adb-touching tool documents `adb_command_failed` in its description", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    const seen = tools.filter((t) => ADB_TOUCHING_TOOLS.has(t.name));
    expect(seen.length).toBe(ADB_TOUCHING_TOOLS.size);
    for (const tool of seen) {
      expect(tool.description ?? "").toContain("adb_command_failed");
    }
  });

  // Same contract for `adb_not_found` — every adb-touching tool resolves the
  // adb binary and can surface this code, so its description must name it.
  it("every adb-touching tool documents `adb_not_found` in its description", async () => {
    const client = await harness();
    const { tools } = await client.listTools();
    const seen = tools.filter((t) => ADB_TOUCHING_TOOLS.has(t.name));
    expect(seen.length).toBe(ADB_TOUCHING_TOOLS.size);
    for (const tool of seen) {
      expect(tool.description ?? "").toContain("adb_not_found");
    }
  });
});

/** Tools whose handler reaches an adb subprocess (and so can surface `adb_command_failed`). */
const ADB_TOUCHING_TOOLS = new Set([
  "android_debug_list_devices",
  "android_debug_start_session",
  "android_debug_app_control",
  "android_debug_clear_app_data",
  "android_debug_get_app_state",
  "android_debug_tap",
  "android_debug_input_text",
  "android_debug_send_key",
  "android_debug_swipe",
  "android_debug_capture",
  "android_debug_tap_node",
]);

// Every session/run-scoped tool resolves its runId BEFORE any adb call, so an
// unknown runId must surface as a clean domain error — never a raw protocol
// error. `no_active_session` for the live-session tools; `run_missing` for the
// tools that resolve a run folder from disk.
const UNKNOWN_RUN_ID = "no-such-run-id";
const BAD_RUNID_CASES: Array<[string, Record<string, unknown>, string]> = [
  ["android_debug_mark_event", { name: "x" }, "no_active_session"],
  ["android_debug_app_control", { action: "stop" }, "no_active_session"],
  ["android_debug_clear_app_data", { confirm: true }, "no_active_session"],
  ["android_debug_get_app_state", {}, "no_active_session"],
  ["android_debug_tap", { x: 1, y: 1 }, "no_active_session"],
  ["android_debug_tap_node", { x: 1, y: 1 }, "no_active_session"],
  ["android_debug_input_text", { text: "x" }, "no_active_session"],
  ["android_debug_send_key", { key: "BACK" }, "no_active_session"],
  ["android_debug_swipe", { x1: 1, y1: 1, x2: 2, y2: 2 }, "no_active_session"],
  ["android_debug_capture", { kinds: ["screenshot"] }, "no_active_session"],
  ["android_debug_search_logs", {}, "run_missing"],
  ["android_debug_extract_crash_context", {}, "run_missing"],
  ["android_debug_get_run_summary", {}, "run_missing"],
  ["android_debug_collect_bundle", {}, "run_missing"],
  ["android_debug_stop_session", {}, "run_missing"],
];

describe("error-envelope contract — unknown runId", () => {
  it.each(BAD_RUNID_CASES)(
    "%s returns a domain error, not a protocol error",
    async (toolName, extraArgs, expectedError) => {
      const client = await harness();
      const result = await client.callTool({
        name: toolName,
        arguments: { runId: UNKNOWN_RUN_ID, ...extraArgs },
      });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toBe(expectedError);
      // The domain envelope: structured payload lives in content, never in
      // structuredContent (open decision #13).
      expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
    },
  );
});
