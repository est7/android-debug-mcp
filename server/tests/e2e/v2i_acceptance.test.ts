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
 * v2-I (unified logcat+events timeline) + v2-J (perf snapshot) real-device
 * acceptance — opt-in.
 *
 *   1. Unified timeline (D) — a marker anchors `extract_evidence_context` over
 *      nav + http + logcat + events; rows merge tsMs-ascending and the logcat
 *      `tsRaw`→epoch converter places log rows inside the window.
 *   2. F1 privacy           — logcat messages are redacted on output: opting the
 *      noisy `http/heart-beat` HTTP dump back IN, its embedded `_sign`/`_uid`/
 *      `smei_id`/`uuid` appear only as `***`, never as a plaintext value.
 *   3. F2 noise             — without an explicit `tags` filter, the profile's
 *      noisy tag (`http/heart-beat`) is excluded from the default timeline.
 *   4. v2-J / F4            — `perf_snapshot` parses a gfxinfo + meminfo digest
 *      with non-null Graphics/Code (App Summary colon format) and honors `reset`.
 *
 * Skipped unless `ANDROID_DEBUG_E2E=1`. Needs a connected device with the debug
 * build (H4 nav producer), network for HTTP evidence, and the Poppo checkout for
 * the `poppo-vone` profile. Drive it from the MainActivity bottom-nav home.
 *
 * Enable:
 *   ANDROID_DEBUG_E2E=1 \
 *   ANDROID_DEBUG_E2E_PACKAGE=com.baitu.poppo \
 *   ANDROID_DEBUG_E2E_PROJECT_ROOT=/Users/est9/AndroidStudioProjects/submodulepoppo \
 *   [ANDROID_DEBUG_E2E_SERIAL=<serial>] \
 *   bun run test -- server/tests/e2e/v2i_acceptance.test.ts
 */

const E2E = process.env.ANDROID_DEBUG_E2E === "1";
const PACKAGE = process.env.ANDROID_DEBUG_E2E_PACKAGE ?? "com.baitu.poppo";
const SERIAL = process.env.ANDROID_DEBUG_E2E_SERIAL;
const PROJECT_ROOT = process.env.ANDROID_DEBUG_E2E_PROJECT_ROOT;

const STEP_TIMEOUT = 60_000;
const SETUP_TIMEOUT = 90_000;
const FLUSH_WAIT_MS = 2_500;

const suite = E2E ? describe : describe.skip;

const ctx: { runId?: string } = {};
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

type Rec = Record<string, unknown>;

async function markNow(name: string): Promise<string> {
  const m = expectOk(await call("android_debug_mark_event", { runId: runId(), name }));
  return m.ts as string;
}

async function appPids(): Promise<number[]> {
  const st = expectOk(await call("android_debug_get_app_state", { runId: runId() }));
  return ((st.pids as number[]) ?? []).filter(Number.isInteger);
}

/** Keys whose value, if it appears in a logcat message at all, must be `***`. */
const SECRET_KEYS = ["_sign", "_uid", "smei_id", "uuid", "oaid", "imei"] as const;

suite("v2-I + v2-J real-device acceptance", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "adm-v2i-"));
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
    resetPathsCache();
    server = new McpServer({ name: "v2i-acceptance", version: "0.0.0-test" });
    manager = new SessionManager();
    registerAllTools(server, manager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "v2i-client", version: "0.0.0-test" });
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
    await sleep(FLUSH_WAIT_MS);
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
    "scenario 1 — unified timeline merges nav/http/logcat/events tsMs-ascending (D)",
    async () => {
      const markerIso = await markNow("v2i_probe");
      const pids = await appPids();
      expect(pids.length, "no app pids — is the app running?").toBeGreaterThan(0);

      // Drive interaction AFTER the marker so the window carries fresh activity.
      await tapNavBySuffix("navMsg");
      await sleep(FLUSH_WAIT_MS);
      await tapNavBySuffix("navLive");
      await sleep(FLUSH_WAIT_MS);

      const s = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: markerIso,
          beforeMs: 5_000,
          afterMs: 30_000,
          sources: [
            { source: "poppo_nav" },
            { source: "poppo_http", pathPrefix: "/" },
            { source: "logcat", pids },
            { source: "events" },
          ],
          limit: 300,
        }),
      );
      const records = (s.records as Rec[]) ?? [];
      expect(records.length).toBeGreaterThan(0);

      // Merged stream is tsMs-ascending.
      for (let i = 1; i < records.length; i++) {
        expect((records[i]?.tsMs as number) >= (records[i - 1]?.tsMs as number)).toBe(true);
      }

      // The logcat converter placed log rows on the epoch timeline, inside the window.
      const sources = new Set(records.map((r) => r.source));
      expect(sources.has("logcat"), "logcat rows missing — tsRaw→epoch converter?").toBe(true);
      const range = s.tsMsRange as { from: number; to: number };
      for (const r of records.filter((r) => r.source === "logcat")) {
        const ts = r.tsMs as number;
        expect(ts >= range.from && ts <= range.to).toBe(true);
      }

      // Verify the events source on its own — in the 4-source merge the logcat
      // flood can truncate the window (at `limit`) before the mark's early tsMs.
      const ev = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: markerIso,
          beforeMs: 5_000,
          afterMs: 30_000,
          sources: [{ source: "events" }],
          limit: 50,
        }),
      );
      const evRecords = (ev.records as Rec[]) ?? [];
      expect(
        evRecords.some((r) => r.type === "mark" && r.name === "v2i_probe"),
        "v2i_probe mark not returned by the events source",
      ).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 2 — logcat timeline messages are redacted on output (F1)",
    async () => {
      const markerIso = await markNow("v2i_redact");
      // navMe drives a /user/info heart-beat burst whose logcat dump embeds device ids.
      await tapNavBySuffix("navMe");
      await sleep(FLUSH_WAIT_MS * 2);

      const s = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: markerIso,
          beforeMs: 2_000,
          afterMs: 30_000,
          // Opt the noisy HTTP dump back IN so there is something to redact.
          sources: [{ source: "logcat", tags: ["http/heart-beat"] }],
          limit: 300,
        }),
      );
      const logRows = ((s.records as Rec[]) ?? []).filter((r) => r.source === "logcat");
      if (logRows.length === 0) {
        console.warn("scenario 2: no http/heart-beat in window — redaction assertion skipped");
        return;
      }
      for (const r of logRows) {
        const msg = String(r.message ?? "");
        for (const key of SECRET_KEYS) {
          const m = new RegExp(`${key}\\s*[=:]\\s*([^\\s&"',]+)`, "i").exec(msg);
          if (m) {
            expect(m[1], `${key} not redacted: ${msg.slice(0, 100)}`).toContain("***");
          }
        }
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 3 — http/heart-beat is excluded from the default timeline (F2)",
    async () => {
      const markerIso = await markNow("v2i_noise");
      await sleep(FLUSH_WAIT_MS * 2); // let a heart-beat fire

      const s = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: markerIso,
          beforeMs: 2_000,
          afterMs: 30_000,
          sources: [{ source: "logcat", level: "D" }], // no `tags` → profile noisy tag excluded
          limit: 300,
        }),
      );
      const tags = new Set(
        ((s.records as Rec[]) ?? []).filter((r) => r.source === "logcat").map((r) => r.tag),
      );
      expect(tags.has("http/heart-beat")).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "scenario 4 — perf_snapshot parses gfxinfo + meminfo (Graphics/Code non-null) and resets (v2-J / F4)",
    async () => {
      const snap = expectOk(await call("android_debug_perf_snapshot", { runId: runId() }));
      const gfx = snap.gfxinfo as Rec | undefined;
      const mem = snap.meminfo as Rec | undefined;
      expect(gfx, "gfxinfo digest missing").toBeDefined();
      expect(mem, "meminfo digest missing").toBeDefined();
      expect(typeof gfx?.totalFrames).toBe("number");
      expect(typeof mem?.totalPssKb).toBe("number");
      // F4: Graphics/Code come from the App Summary colon format on real devices.
      expect(mem?.graphicsKb, "graphicsKb null — App Summary colon parse?").not.toBeNull();
      expect(mem?.codeKb, "codeKb null — App Summary colon parse?").not.toBeNull();

      const reset = expectOk(
        await call("android_debug_perf_snapshot", {
          runId: runId(),
          kinds: ["gfxinfo"],
          reset: true,
        }),
      );
      expect(reset.reset).toBe(true);
      expect(reset.gfxinfo).toBeDefined();
    },
    STEP_TIMEOUT,
  );
});
