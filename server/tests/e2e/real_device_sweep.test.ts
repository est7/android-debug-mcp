import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/bootstrap.ts";
import { ANDROID_DEBUG_TOOL_NAMES } from "../../src/mcp/constants.ts";
import { SessionManager } from "../../src/session/manager.ts";
import { resetPathsCache } from "../../src/store/paths.ts";

/**
 * Real-device end-to-end sweep — opt-in acceptance harness.
 *
 * Unlike the rest of `tests/`, this file talks to a REAL adb + a REAL connected
 * device. It is the executable form of `docs/test-plan.md`'s manual checklist:
 * it drives the full 25-tool inventory through one realistic session so the
 * *sequence* + *real adb arg-building* + *real parsers* (`parseDevicesL`, UI
 * dump, logcat, screencap bytes) + *real run-folder writes / redaction* are
 * exercised together — the seam unit `vi.mock` tests cannot reach.
 *
 * It is **NOT a CI regression net**: it is skipped unless explicitly enabled,
 * needs a device + the target app installed (+ network for HTTP evidence), and
 * asserts contract SHAPE (no `isError`, required fields + types) rather than
 * device-specific values. The one hard content assertion is the redacted
 * bundle scan (audit P0): no live `Authorization`/`Cookie`/`Set-Cookie` value
 * and no unredacted `_sign=` survives export.
 *
 * Enable:
 *   ANDROID_DEBUG_E2E=1 \
 *   ANDROID_DEBUG_E2E_PACKAGE=com.baitu.poppo \
 *   [ANDROID_DEBUG_E2E_SERIAL=<serial>] \          # required if >1 device
 *   [ANDROID_DEBUG_E2E_PROJECT_ROOT=/path/to/app] \ # loads profile + maps source
 *   [ANDROID_DEBUG_E2E_EVIDENCE_SOURCE=poppo_http] \
 *   [ANDROID_DEBUG_E2E_ALLOW_DESTRUCTIVE=1] \       # opt-in for clear_app_data
 *   bun run test -- server/tests/e2e/real_device_sweep.test.ts
 *
 * Destructive steps (`clear_app_data`) stay behind ALLOW_DESTRUCTIVE so the
 * default sweep never wipes the device under test; everything else still runs.
 */

const E2E = process.env.ANDROID_DEBUG_E2E === "1";
const PACKAGE = process.env.ANDROID_DEBUG_E2E_PACKAGE ?? "com.baitu.poppo";
const SERIAL = process.env.ANDROID_DEBUG_E2E_SERIAL;
const PROJECT_ROOT = process.env.ANDROID_DEBUG_E2E_PROJECT_ROOT;
const EVIDENCE_SOURCE = process.env.ANDROID_DEBUG_E2E_EVIDENCE_SOURCE ?? "poppo_http";
const ALLOW_DESTRUCTIVE = process.env.ANDROID_DEBUG_E2E_ALLOW_DESTRUCTIVE === "1";

// Real adb ops (screencap, uiautomator dump, logcat spawn, pull) are far slower
// than the default 5s vitest budget.
const STEP_TIMEOUT = 30_000;
const SETUP_TIMEOUT = 90_000;

const suite = E2E ? describe : describe.skip;
const destructiveIt = E2E && ALLOW_DESTRUCTIVE ? it : it.skip;

interface NodeRef {
  readonly resourceId: string | null;
  readonly class: string | null;
  readonly package: string | null;
  readonly bounds: unknown;
  readonly index: number;
  readonly clickable: boolean;
  readonly focusable: boolean;
}

// Cross-step state. vitest runs tests within a file sequentially in definition
// order, so later steps read what earlier steps wrote.
const ctx: {
  runId?: string;
  deviceSerial?: string;
  pids: number[];
  tap: { x: number; y: number };
  markerIso?: string;
  recordingId?: string;
  anchorNode: NodeRef | null;
  foregroundActivity: string | null;
  ancestorChain: NodeRef[];
} = {
  pids: [],
  tap: { x: 100, y: 100 },
  anchorNode: null,
  foregroundActivity: null,
  ancestorChain: [],
};

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

/** Assert a clean tool result and return its structured payload. */
function expectOk(result: unknown): Record<string, unknown> {
  expect((result as { isError?: boolean }).isError, callText(result)).toBeFalsy();
  return structured(result);
}

function runId(): string {
  if (ctx.runId === undefined) throw new Error("runId not set — start_session step failed");
  return ctx.runId;
}

suite("real-device 25-tool sweep", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "adm-e2e-"));
    process.env.ANDROID_DEBUG_MCP_RUN_ROOT = scratch;
    resetPathsCache();
    server = new McpServer({ name: "e2e-sweep", version: "0.0.0-test" });
    manager = new SessionManager();
    registerAllTools(server, manager);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "e2e-client", version: "0.0.0-test" });
    await Promise.all([server.connect(st), client.connect(ct)]);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    // Defensive stop in case the stop_session step did not run (earlier failure).
    for (const s of manager.listActive()) await s.finalize("stopped").catch(() => undefined);
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    // biome-ignore lint/performance/noDelete: must unset, not set to "undefined".
    delete process.env.ANDROID_DEBUG_MCP_RUN_ROOT;
    resetPathsCache();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it(
    "list_devices → target device visible",
    async () => {
      const s = expectOk(await call("android_debug_list_devices", {}));
      const devices = s.devices as Array<{ deviceSerial: string; state: string }>;
      expect(Array.isArray(devices)).toBe(true);
      expect(devices.length).toBeGreaterThan(0);
      for (const d of devices) {
        expect(typeof d.deviceSerial).toBe("string");
        expect(typeof d.state).toBe("string");
      }
      if (SERIAL !== undefined) {
        expect(devices.some((d) => d.deviceSerial === SERIAL)).toBe(true);
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "start_session → runId anchors the run",
    async () => {
      const s = expectOk(
        await call("android_debug_start_session", {
          packageName: PACKAGE,
          ...(SERIAL !== undefined ? { deviceSerial: SERIAL } : {}),
          ...(PROJECT_ROOT !== undefined ? { projectRoot: PROJECT_ROOT } : {}),
          launchOnStart: true,
        }),
      );
      expect(typeof s.runId).toBe("string");
      expect((s.runId as string).length).toBeGreaterThan(0);
      expect(typeof s.deviceSerial).toBe("string");
      expect(s.packageName).toBe(PACKAGE);
      ctx.runId = s.runId as string;
      ctx.deviceSerial = s.deviceSerial as string;
    },
    SETUP_TIMEOUT,
  );

  it(
    "get_app_state → foreground + pids",
    async () => {
      const s = expectOk(await call("android_debug_get_app_state", { runId: runId() }));
      expect(typeof s.foreground).toBe("boolean");
      expect(Array.isArray(s.pids)).toBe(true);
      ctx.pids = (s.pids as number[]).filter((p) => Number.isInteger(p));
      ctx.foregroundActivity = (s.activity as string | null) ?? null;
    },
    STEP_TIMEOUT,
  );

  it(
    "mark_event → marker for later evidence windows",
    async () => {
      const s = expectOk(
        await call("android_debug_mark_event", { runId: runId(), name: "e2e_sweep_marker" }),
      );
      expect(s.name).toBe("e2e_sweep_marker");
      expect(typeof s.ts).toBe("string");
      ctx.markerIso = s.ts as string;
    },
    STEP_TIMEOUT,
  );

  it(
    "capture (screenshot + ui_dump) → artifacts on disk",
    async () => {
      const s = expectOk(
        await call("android_debug_capture", {
          runId: runId(),
          kinds: ["screenshot", "ui_dump"],
          label: "e2e_capture",
        }),
      );
      expect(typeof s.captureId).toBe("string");
      expect(typeof s.screenshotPath).toBe("string");
      expect(typeof s.uiDumpPath).toBe("string");
    },
    STEP_TIMEOUT,
  );

  it(
    "screen_recording start → explicit, bounded MP4 capture",
    async () => {
      const s = expectOk(
        await call("android_debug_screen_recording", {
          runId: runId(),
          action: "start",
          maxDurationSeconds: 30,
        }),
      );
      expect(s.status).toBe("recording");
      expect(typeof s.recordingId).toBe("string");
      ctx.recordingId = s.recordingId as string;
    },
    STEP_TIMEOUT,
  );

  it(
    "list_elements → element tree (pick a tap target)",
    async () => {
      const s = expectOk(await call("android_debug_list_elements", { runId: runId() }));
      const elements = s.elements as Array<{
        center?: { x: number; y: number };
        clickable?: boolean;
      }>;
      expect(Array.isArray(elements)).toBe(true);
      expect(typeof s.elementCount).toBe("number");
      const target =
        elements.find((e) => e.clickable && e.center) ?? elements.find((e) => e.center);
      if (target?.center) ctx.tap = { x: target.center.x, y: target.center.y };
    },
    STEP_TIMEOUT,
  );

  it(
    "tap_node → anchorNode + ancestorChain for source mapping",
    async () => {
      const s = expectOk(
        await call("android_debug_tap_node", {
          runId: runId(),
          x: ctx.tap.x,
          y: ctx.tap.y,
        }),
      );
      expect(typeof s.ts).toBe("string");
      expect(["tapped_node", "ancestor", "none"]).toContain(s.anchorSource);
      expect(Array.isArray(s.ancestorChain)).toBe(true);
      ctx.anchorNode = (s.anchorNode as NodeRef | null) ?? null;
      ctx.ancestorChain = (s.ancestorChain as NodeRef[]) ?? [];
      if (typeof s.preTapForegroundActivity === "string") {
        ctx.foregroundActivity = s.preTapForegroundActivity;
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "map_ui_node_to_source → confidence + candidates (shape)",
    async () => {
      const s = expectOk(
        await call("android_debug_map_ui_node_to_source", {
          runId: runId(),
          anchorNode: ctx.anchorNode,
          foregroundActivity: ctx.foregroundActivity,
          ancestorChain: ctx.ancestorChain,
        }),
      );
      expect(typeof s.confidence).toBe("number");
      expect(Array.isArray(s.candidates)).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "raw interaction tools (tap / swipe / long_press / send_key / input_text) → ts",
    async () => {
      const { x, y } = ctx.tap;
      const tap = expectOk(await call("android_debug_tap", { runId: runId(), x, y }));
      expect(typeof tap.ts).toBe("string");

      const swipe = expectOk(
        await call("android_debug_swipe", {
          runId: runId(),
          x1: x,
          y1: y,
          x2: x,
          y2: Math.max(0, y - 200),
          durationMs: 200,
        }),
      );
      expect(typeof swipe.ts).toBe("string");

      const lp = expectOk(await call("android_debug_long_press", { runId: runId(), x, y }));
      expect(typeof lp.ts).toBe("string");

      const key = expectOk(await call("android_debug_send_key", { runId: runId(), key: "BACK" }));
      expect(typeof key.ts).toBe("string");

      const txt = expectOk(
        await call("android_debug_input_text", { runId: runId(), text: "e2e probe" }),
      );
      expect(typeof txt.ts).toBe("string");
      expect(typeof txt.redacted).toBe("boolean");
    },
    STEP_TIMEOUT,
  );

  it(
    "screen_recording stop → finalized MP4 and sampled frames under run artifacts",
    async () => {
      if (ctx.recordingId === undefined) throw new Error("recordingId not set");
      const s = expectOk(
        await call("android_debug_screen_recording", {
          runId: runId(),
          action: "stop",
          recordingId: ctx.recordingId,
        }),
      );
      expect(s.status).toBe("saved");
      expect(typeof s.videoPath).toBe("string");
      expect(statSync(s.videoPath as string).size).toBeGreaterThan(0);
      expect(Array.isArray(s.framePaths)).toBe(true);
      expect((s.framePaths as string[]).length).toBeGreaterThan(0);
      for (const framePath of s.framePaths as string[]) {
        expect(statSync(framePath).size).toBeGreaterThan(0);
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "search_logs → normal + pid filter + aggregation",
    async () => {
      const normal = expectOk(
        await call("android_debug_search_logs", { runId: runId(), level: "I" }),
      );
      expect(Array.isArray(normal.entries)).toBe(true);
      expect(typeof normal.scanned).toBe("number");
      expect(typeof normal.matched).toBe("number");

      if (ctx.pids.length > 0) {
        const byPid = expectOk(
          await call("android_debug_search_logs", { runId: runId(), level: "I", pids: ctx.pids }),
        );
        const entries = byPid.entries as Array<{ pid: number }>;
        for (const e of entries) expect(ctx.pids).toContain(e.pid);
      }

      const agg = expectOk(
        await call("android_debug_search_logs", {
          runId: runId(),
          level: "I",
          count: true,
          groupBy: "level",
        }),
      );
      expect(agg.groupBy).toBe("level");
      expect(Array.isArray(agg.counts)).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "search_evidence → contract shape (+ no-tsMsRange warning when applicable)",
    async () => {
      const s = expectOk(
        await call("android_debug_search_evidence", {
          runId: runId(),
          query: { source: EVIDENCE_SOURCE, pathPrefix: "/" },
        }),
      );
      expect(Array.isArray(s.records)).toBe(true);
      expect(s.statsRun).toBeDefined();
      // `warnings` is optional; when present it must be a string[] (soft-empty
      // reasons or the poppo_http "not session-scoped" caveat).
      if (s.warnings !== undefined) {
        expect(Array.isArray(s.warnings)).toBe(true);
        for (const w of s.warnings as unknown[]) expect(typeof w).toBe("string");
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "extract_evidence_context → marker-anchored window",
    async () => {
      expect(ctx.markerIso).toBeDefined();
      const s = expectOk(
        await call("android_debug_extract_evidence_context", {
          runId: runId(),
          markerIsoTs: ctx.markerIso,
          query: { source: EVIDENCE_SOURCE },
        }),
      );
      expect(Array.isArray(s.records)).toBe(true);
      const range = s.tsMsRange as { from: number; to: number } | undefined;
      if (range) {
        expect(typeof range.from).toBe("number");
        expect(range.to).toBeGreaterThanOrEqual(range.from);
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "extract_crash_context → graceful on a non-crashed run",
    async () => {
      const s = expectOk(await call("android_debug_extract_crash_context", { runId: runId() }));
      expect(typeof s.crashCount).toBe("number");
      expect(s.crashCount as number).toBeGreaterThanOrEqual(0);
    },
    STEP_TIMEOUT,
  );

  it(
    "get_run_summary → summary shape on the active run",
    async () => {
      const s = expectOk(await call("android_debug_get_run_summary", { runId: runId() }));
      expect(s.runId).toBe(runId());
      expect(typeof s.status).toBe("string");
      expect(typeof s.crashFound).toBe("boolean");
      expect(s.counts).toBeDefined();
    },
    STEP_TIMEOUT,
  );

  it(
    "collect_bundle (redacted) → no live credential survives export",
    async () => {
      const s = expectOk(
        await call("android_debug_collect_bundle", { runId: runId(), logs: "redacted" }),
      );
      expect(s.logs).toBe("redacted");
      expect(typeof s.bundlePath).toBe("string");
      expect(s.byteSize as number).toBeGreaterThan(0);

      // Extract into a dedicated dir — NOT `scratch`, whose live run folder
      // still holds the unredacted logcat/evidence the bundle redacts away.
      const extractDir = mkdtempSync(join(tmpdir(), "adm-e2e-extract-"));
      try {
        execFileSync("tar", ["-xzf", s.bundlePath as string, "-C", extractDir]);
        assertNoLeakedSecrets(extractDir);
      } finally {
        rmSync(extractDir, { recursive: true, force: true });
      }
    },
    STEP_TIMEOUT,
  );

  it(
    "app_control restart → action echoed",
    async () => {
      const s = expectOk(
        await call("android_debug_app_control", { runId: runId(), action: "restart" }),
      );
      expect(s.action).toBe("restart");
      expect(Array.isArray(s.pids)).toBe(true);
    },
    STEP_TIMEOUT,
  );

  destructiveIt(
    "clear_app_data → cleared (gated by ANDROID_DEBUG_E2E_ALLOW_DESTRUCTIVE)",
    async () => {
      const s = expectOk(
        await call("android_debug_clear_app_data", { runId: runId(), confirm: true }),
      );
      expect(s.cleared).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "stop_session → finalize the run",
    async () => {
      const s = expectOk(await call("android_debug_stop_session", { runId: runId() }));
      expect(s.runId).toBe(runId());
      expect(typeof s.status).toBe("string");
    },
    STEP_TIMEOUT,
  );

  it(
    "list_runs → the swept run is listed",
    async () => {
      const s = expectOk(await call("android_debug_list_runs", {}));
      const runs = s.runs as Array<{ runId: string }>;
      expect(Array.isArray(runs)).toBe(true);
      expect(runs.some((r) => r.runId === runId())).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it("exercised the full 25-tool inventory", () => {
    // Guards against the inventory growing without this sweep noticing. The
    // set below is every tool the steps above call.
    const swept = new Set([
      "android_debug_list_devices",
      "android_debug_start_session",
      "android_debug_get_app_state",
      "android_debug_mark_event",
      "android_debug_capture",
      "android_debug_screen_recording",
      "android_debug_list_elements",
      "android_debug_tap_node",
      "android_debug_map_ui_node_to_source",
      "android_debug_tap",
      "android_debug_swipe",
      "android_debug_long_press",
      "android_debug_send_key",
      "android_debug_input_text",
      "android_debug_search_logs",
      "android_debug_search_evidence",
      "android_debug_extract_evidence_context",
      "android_debug_extract_crash_context",
      "android_debug_get_run_summary",
      "android_debug_collect_bundle",
      "android_debug_app_control",
      "android_debug_clear_app_data",
      "android_debug_stop_session",
      "android_debug_list_runs",
    ]);
    expect(swept).toEqual(new Set(ANDROID_DEBUG_TOOL_NAMES));
  });
});

/**
 * Walk every textual file under `root` and assert no UNREDACTED credential
 * survived bundle export. Expresses the audit P0 leak patterns as negatives:
 * a redacted bundle may keep the KEY names, but never a live value.
 */
function assertNoLeakedSecrets(root: string): void {
  // `Authorization`/`Cookie`/`Set-Cookie` header followed by something other
  // than the redaction placeholder (`***` / `[REDACTED]`).
  const liveHeader = /(authorization|set-cookie2?|cookie)\s*[:=]\s*(?!\*\*\*|\[redacted\])\S{8,}/i;
  // `_sign=<value>` where the value is not the URL-encoded placeholder.
  const liveSign = /_sign["']?\s*[:=]\s*"?(?!%5bredacted%5d|\[redacted\]|\*\*\*)[a-z0-9]{6,}/i;
  for (const file of walkFiles(root)) {
    if (!isTextFile(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      expect(
        liveHeader.test(line),
        `live credential header leaked in ${file}: ${line.slice(0, 120)}`,
      ).toBe(false);
      expect(liveSign.test(line), `unredacted _sign leaked in ${file}: ${line.slice(0, 120)}`).toBe(
        false,
      );
    }
  }
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (entry.isFile()) yield p;
  }
}

function isTextFile(file: string): boolean {
  if (/\.(png|jpg|jpeg|gz|tar|webp|bin)$/i.test(file)) return false;
  // Skip the archive itself; we scan the extracted tree.
  if (file.endsWith(".tar.gz")) return false;
  try {
    return statSync(file).size < 8 * 1024 * 1024;
  } catch {
    return false;
  }
}
