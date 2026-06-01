import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/bootstrap.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

/**
 * v2-H real-device acceptance — opt-in.
 *
 * Proves the v2-H contract end-to-end on a REAL device whose installed
 * **debug** build carries the H4 nav producer (debuglibrary nav-logs writer):
 *
 *   1. Current screen   — `search_evidence({source:"poppo_nav"})` latest = visible fragment.
 *   2. Page→API attrib  — a nav record's ts anchors `extract_evidence_context(sources:[nav,http])`,
 *                          merging both kinds on one tsMs timeline.
 *   3. Token economy     — digest default ≪ `fullRecords` for the same query.
 *   4. Privacy           — device IDs never leak: absent from digest; `[REDACTED]` under
 *                          `fields:["request.decoded"]` and under `fullRecords`.
 *
 * Skipped unless `ANDROID_DEBUG_E2E=1`. Needs a connected device, the app
 * installed as a **debug build with H4**, network (HTTP evidence), and the
 * Poppo source checkout for the `poppo-vone` profile. If the nav producer is
 * NOT installed, scenarios 1–2 fail loudly with a build hint — that is the
 * acceptance gate, not a flake.
 *
 * Enable:
 *   ANDROID_DEBUG_E2E=1 \
 *   ANDROID_DEBUG_E2E_PACKAGE=com.baitu.poppo \
 *   ANDROID_DEBUG_E2E_PROJECT_ROOT=/Users/est9/AndroidStudioProjects/submodulepoppo \
 *   [ANDROID_DEBUG_E2E_SERIAL=<serial>] \
 *   bun run test -- server/tests/e2e/v2h_acceptance.test.ts
 */

const E2E = process.env.ANDROID_DEBUG_E2E === "1";
const PACKAGE = process.env.ANDROID_DEBUG_E2E_PACKAGE ?? "com.baitu.poppo";
const SERIAL = process.env.ANDROID_DEBUG_E2E_SERIAL;
const PROJECT_ROOT = process.env.ANDROID_DEBUG_E2E_PROJECT_ROOT;

const STEP_TIMEOUT = 45_000;
const SETUP_TIMEOUT = 90_000;
/** nav/http writers flush ~1s; allow device write + lazy pull to settle. */
const FLUSH_WAIT_MS = 2_500;

const suite = E2E ? describe : describe.skip;

const ctx: { runId?: string; pids: number[] } = { pids: [] };
let scratch = "";
let client: Client;
let server: McpServer;
let manager: SessionManager;

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
function callText(result: unknown): string {
  return (result as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
}
async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  return client.callTool({ name, arguments: args });
}
function expectOk(result: unknown): Record<string, unknown> {
  expect((result as { isError?: boolean }).isError, callText(result)).toBeFalsy();
  return structured(result);
}
function runId(): string {
  if (ctx.runId === undefined) throw new Error("runId not set — start_session failed");
  return ctx.runId;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Device-identifier keys that must never appear with an unredacted value. */
const SENSITIVE_DECODED_KEYS = [
  "imei",
  "oaid",
  "smei_id",
  "appsflyer_id",
  "_uid",
  "uuid",
  "_sign",
] as const;

/** Fail if any sensitive key appears with a value other than the redaction placeholder. */
function assertNoUnredactedDeviceIds(serialized: string, where: string): void {
  for (const key of SENSITIVE_DECODED_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"(?!\\[REDACTED\\])[^"]+"`, "i");
    const m = re.exec(serialized);
    expect(m === null, `${where}: unredacted ${key} leaked → ${m?.[0]?.slice(0, 80)}`).toBe(true);
  }
}

/** Tap the bottom-nav element whose resourceId ends with `suffix`; returns true if tapped. */
async function tapNavBySuffix(suffix: string): Promise<boolean> {
  const s = expectOk(
    await call("android_debug_list_elements", { runId: runId(), filter: { clickableOnly: true } }),
  );
  const elements = s.elements as Array<{
    resourceId?: string | null;
    center?: { x: number; y: number };
  }>;
  const target = elements.find((e) => (e.resourceId ?? "").endsWith(suffix) && e.center);
  if (!target?.center) return false;
  expectOk(
    await call("android_debug_tap", { runId: runId(), x: target.center.x, y: target.center.y }),
  );
  return true;
}

/**
 * Collect ALL matching poppo_nav records across pages. The streaming source
 * returns records oldest-first and truncates at `limit` (next page via cursor),
 * so a single page's last element is the limit-th OLDEST record, not the latest
 * visible page. Page to exhaustion so `.at(-1)` is the true newest record.
 */
async function navNow(typeIn: string[]): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const s = expectOk(
      await call("android_debug_search_evidence", {
        runId: runId(),
        query: { source: "poppo_nav", typeIn },
        limit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    all.push(...((s.records as Array<Record<string, unknown>>) ?? []));
    cursor = (s as { nextCursor?: string }).nextCursor;
  } while (cursor !== undefined);
  return all;
}

suite("v2-H real-device acceptance", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "adm-v2h-"));
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
    resetPathsCache();
    server = new McpServer({ name: "v2h-acceptance", version: "0.0.0-test" });
    manager = new SessionManager();
    registerAllTools(server, manager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "v2h-client", version: "0.0.0-test" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const start = expectOk(
      await call("android_debug_start_session", {
        packageName: PACKAGE,
        ...(SERIAL !== undefined ? { deviceSerial: SERIAL } : {}),
        ...(PROJECT_ROOT !== undefined ? { projectRoot: PROJECT_ROOT } : {}),
        launchOnStart: true,
      }),
    );
    ctx.runId = start.runId as string;
    // Let launch settle so the home screen + initial HTTP burst happen.
    await sleep(FLUSH_WAIT_MS);
    const state = expectOk(await call("android_debug_get_app_state", { runId: runId() }));
    ctx.pids = ((state.pids as number[]) ?? []).filter(Number.isInteger);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (ctx.runId !== undefined) {
      await call("android_debug_stop_session", { runId: ctx.runId }).catch(() => undefined);
    }
    for (const sx of manager.listActive()) await sx.finalize("stopped").catch(() => undefined);
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
    delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    resetPathsCache();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it(
    "scenario 1 — poppo_nav reports the visible fragment, and it changes with the tab",
    async () => {
      // Drive two distinct bottom-nav tabs; each should emit a distinct fragment nav record.
      const tappedMe = await tapNavBySuffix("navMe");
      expect(tappedMe, "navMe not found on screen — is this the Poppo home screen?").toBe(true);
      await sleep(FLUSH_WAIT_MS);
      const afterMe = await navNow(["fragment"]);
      expect(
        afterMe.length,
        "no poppo_nav fragment records — build+install the DEBUG apk with H4 (debuglibrary nav producer)",
      ).toBeGreaterThan(0);
      const meLeaf = afterMe.at(-1)?.name as string;
      expect(typeof meLeaf).toBe("string");
      expect(meLeaf.length).toBeGreaterThan(0);

      const tappedMsg = await tapNavBySuffix("navMsg");
      expect(tappedMsg, "navMsg not found").toBe(true);
      await sleep(FLUSH_WAIT_MS);
      const afterMsg = await navNow(["fragment"]);
      const msgLeaf = afterMsg.at(-1)?.name as string;
      expect(typeof msgLeaf).toBe("string");

      // Distinct tabs → distinct visible fragment leaf. This proves the leaf-resumed
      // rule tracks the ViewPager page, not a stale/offscreen fragment.
      expect(msgLeaf, `tab switch did not change visible fragment (both "${meLeaf}")`).not.toBe(
        meLeaf,
      );

      // An activity-level record for MainActivity should also exist.
      const activities = await navNow(["activity"]);
      expect(activities.some((r) => String(r.name).includes("MainActivity"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 2 — page→API attribution via multi-source timeline",
    async () => {
      const frags = await navNow(["fragment"]);
      expect(
        frags.length,
        "need at least one nav record (scenario 1 should have produced them)",
      ).toBeGreaterThan(0);
      const anchor = frags.at(-1) as Record<string, unknown>;
      const markerMs = anchor.tsMs as number;
      const markerIso = new Date(markerMs).toISOString();

      const s = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: markerIso,
          beforeMs: 30_000,
          afterMs: 30_000,
          sources: [{ source: "poppo_nav" }, { source: "poppo_http", pathPrefix: "/" }],
        }),
      );
      const records = (s.records as Array<Record<string, unknown>>) ?? [];
      expect(records.length).toBeGreaterThan(0);

      // Merged stream is tsMs-ascending and carries both kinds.
      for (let i = 1; i < records.length; i++) {
        expect((records[i]?.tsMs as number) >= (records[i - 1]?.tsMs as number)).toBe(true);
      }
      const sourcesSeen = new Set(records.map((r) => r.source));
      expect(sourcesSeen.has("poppo_nav")).toBe(true);
      // http may legitimately be absent in a 60s window if the page made no calls;
      // assert the merge mechanism at least carried it when present.
      if (!sourcesSeen.has("poppo_http")) {
        console.warn(
          "scenario 2: no poppo_http in window — page made no calls in ±30s; merge shape still validated",
        );
      }
      // tsMsRange echoes the resolved window.
      const range = s.tsMsRange as { from: number; to: number };
      expect(range.from).toBe(markerMs - 30_000);
      expect(range.to).toBe(markerMs + 30_000);
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 3 — digest default is far smaller than fullRecords",
    async () => {
      const digest = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: "poppo_http", pathPrefix: "/" },
          limit: 10,
        }),
      );
      const digestRecords = (digest.records as Array<Record<string, unknown>>) ?? [];
      expect(
        digestRecords.length,
        "no poppo_http records — did the app make requests?",
      ).toBeGreaterThan(0);

      // Digest carries no heavy envelopes; advertises sections via _meta.preview.
      for (const r of digestRecords) {
        expect(r.request, "digest must not carry request envelope").toBeUndefined();
        expect(r.response, "digest must not carry response envelope").toBeUndefined();
        const meta = (r._meta as { preview?: { available?: unknown } } | undefined)?.preview;
        expect(Array.isArray(meta?.available)).toBe(true);
      }

      const full = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: "poppo_http", pathPrefix: "/" },
          limit: 10,
          fullRecords: true,
        }),
      );
      const fullRecords = (full.records as Array<Record<string, unknown>>) ?? [];
      expect(byteLen(digestRecords)).toBeLessThan(byteLen(fullRecords));
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 4 — device identifiers never leak (digest / fields / fullRecords)",
    async () => {
      // 4a. digest default: sensitive keys absent entirely.
      const digest = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: "poppo_http", pathPrefix: "/" },
          limit: 20,
        }),
      );
      assertNoUnredactedDeviceIds(JSON.stringify(digest.records), "digest default");

      // 4b. opt-in decoded: present but redacted (business fields may remain).
      const decoded = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: "poppo_http", pathPrefix: "/" },
          limit: 20,
          fields: ["request.decoded"],
        }),
      );
      assertNoUnredactedDeviceIds(JSON.stringify(decoded.records), "fields:[request.decoded]");

      // 4c. fullRecords: full bodies but secrets still redacted.
      const full = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: "poppo_http", pathPrefix: "/" },
          limit: 10,
          fullRecords: true,
        }),
      );
      assertNoUnredactedDeviceIds(JSON.stringify(full.records), "fullRecords");
    },
    STEP_TIMEOUT,
  );
});
