import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWire } from "../../src/mcp/tools/_wire.ts";
import { DORA_PROFILE, DORA_WIRE } from "../../src/profile/dora/index.ts";
import {
  derivePoppoHttpOutcome,
  matchPoppoHttpRecord,
} from "../../src/profile/poppo-vone/poppo_http/match.ts";
import { parsePoppoHttpLine } from "../../src/profile/poppo-vone/poppo_http/record.ts";
import { findBuiltinProfile } from "../../src/profile/registry.ts";
import { compareProjections, fromCapture, readersFor } from "../../src/wire/compare.ts";
import { POPPO_WIRE } from "../../src/wire/policy.ts";
import { buildSnapshot } from "../../src/wire/snapshot.ts";

/**
 * DoraLive as the contract's second producer (docs/contracts/http-log-jsonl.md rev6, §4, §6, §9.2): its golden lines
 * read, its own verdicts win, and its wire is compared by route with its own globals and volatile parameters.
 */

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/wire/dora_golden.jsonl");

const NO_BODY = {
  contentType: null,
  charset: null,
  text: null,
  textBytes: null,
  omittedReason: "no-body",
  preview: null,
  previewBytes: null,
};

function jsonBody(value: unknown) {
  const text = JSON.stringify(value);
  return {
    contentType: "application/json",
    charset: "UTF-8",
    text,
    textBytes: Buffer.byteLength(text, "utf8"),
    omittedReason: null,
    preview: null,
    previewBytes: null,
  };
}

const GLOBALS = (requestId: string) => [
  { name: "_uid", value: "42" },
  { name: "p", value: "android" },
  { name: "c", value: "dora" },
  { name: "v", value: "497" },
  { name: "tz", value: "Asia/Shanghai" },
  { name: "n", value: "wifi" },
  { name: "uuid", value: `device-${requestId}` },
  { name: "requestId", value: requestId },
  { name: "emulator_score", value: "0" },
  { name: "_sign", value: "<redacted>" },
];

interface Spec {
  seq: number;
  method?: string;
  path: string;
  query?: Array<{ name: string; value: string }>;
  decoded?: unknown;
  route?: { controller: string; method: string };
  attempt?: number;
  encrypted?: boolean;
  requestId?: string;
  outcome?: string;
}

/** A DoraLive line as `:apps:dora:debug` writes it (contract §9.2). */
function line(spec: Spec): string {
  const method = spec.method ?? "POST";
  const requestId = spec.requestId ?? `r${spec.seq}`;
  const params = [...GLOBALS(requestId), ...(spec.query ?? [])];
  return JSON.stringify({
    v: 1,
    runId: "run-1",
    seq: spec.seq,
    pid: 7,
    tsMs: 1_800_000_000_000 + spec.seq,
    durationMs: 30,
    method,
    url: `https://api.example${spec.path}?${params.map((p) => `${p.name}=${encodeURIComponent(p.value)}`).join("&")}`,
    path: spec.path,
    host: "api.example",
    protocol: "h2",
    heartBeat: false,
    outcome: spec.outcome ?? "ok",
    request: {
      headers: [
        { name: "Accept", value: "application/json" },
        { name: "X-Device", value: "android" },
        { name: "X-Platform", value: "app" },
      ],
      params,
      decoded: spec.decoded ?? null,
      body:
        method === "POST"
          ? jsonBody(
              spec.route ? { ...spec.route, params_json: spec.decoded } : (spec.decoded ?? {}),
            )
          : NO_BODY,
      owner: { role: "Current" },
      encrypted: spec.encrypted ?? false,
      ...(spec.route ? { route: spec.route } : {}),
      attempt: spec.attempt ?? 1,
    },
    response: {
      status: 200,
      headers: [{ name: "Content-Type", value: "application/json" }],
      body: jsonBody({ code: 0, data: {} }),
      app: { status: null, code: 0, errCode: null, errMsg: null, message: null, ok: true },
    },
    error: null,
  });
}

const SESSION: Spec[] = [
  {
    seq: 1,
    method: "GET",
    path: "/user-service/api/user/card",
    query: [{ name: "target", value: "7" }],
    decoded: { target: "7" },
  },
  {
    seq: 2,
    path: "/common-service/api/route",
    route: { controller: "lang", method: "list" },
    decoded: { lang: "en" },
  },
  {
    seq: 3,
    path: "/common-service/api/route",
    route: { controller: "version", method: "check-version" },
    decoded: { build: 497 },
  },
  {
    seq: 4,
    path: "/user-service/api/user/edit",
    encrypted: true,
    decoded: { nickname: "Ann" },
    outcome: "app_error",
  },
  {
    seq: 5,
    path: "/user-service/api/user/edit",
    encrypted: true,
    decoded: { nickname: "Ann" },
    attempt: 2,
  },
];

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-dora-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function write(name: string, specs: Spec[]): string {
  const path = join(scratch, name);
  writeFileSync(path, `${specs.map(line).join("\n")}\n`);
  return path;
}

describe("DoraLive's golden lines (contract §10 Step 1)", () => {
  const lines = readFileSync(GOLDEN, "utf8").split("\n").filter(Boolean);

  it("all read, and the producer's own verdict wins over the rev5 cascade", () => {
    const records = lines.map(parsePoppoHttpLine);
    expect(records.every((r) => r !== null)).toBe(true);
    expect(records.map((r) => derivePoppoHttpOutcome(r as NonNullable<typeof r>))).toEqual([
      "ok",
      "ok",
      "app_error",
      "malformed",
      "transport_error",
      "ok",
    ]);
  });

  it("a malformed answer is found by the outcome filter, which rev5 would have called ok", () => {
    const malformed = parsePoppoHttpLine(lines[3] as string);
    expect(malformed).not.toBeNull();
    const record = malformed as NonNullable<typeof malformed>;
    expect(matchPoppoHttpRecord(record, { source: "poppo_http", outcome: "malformed" })).toBe(true);
    expect(matchPoppoHttpRecord(record, { source: "poppo_http", outcome: "ok" })).toBe(false);
    const { outcome: _, ...rev5 } = JSON.parse(lines[3] as string);
    const old = parsePoppoHttpLine(JSON.stringify(rev5));
    expect(derivePoppoHttpOutcome(old as NonNullable<typeof old>)).toBe("ok");
  });
});

describe("rev6 fields (contract §1, §3.1)", () => {
  const base = JSON.parse(line(SESSION[1] as Spec));

  it("an unknown outcome is opaque: the record reads and the cascade decides", () => {
    const record = parsePoppoHttpLine(JSON.stringify({ ...base, outcome: "client-cancel" }));
    expect(record).not.toBeNull();
    expect(derivePoppoHttpOutcome(record as NonNullable<typeof record>)).toBe("ok");
  });

  it("a declared field of the wrong type is not read", () => {
    for (const request of [
      { ...base.request, encrypted: "yes" },
      { ...base.request, route: { controller: "lang" } },
      { ...base.request, attempt: 0 },
    ]) {
      expect(parsePoppoHttpLine(JSON.stringify({ ...base, request }))).toBeNull();
    }
  });
});

describe("the dora wire", () => {
  it("is the built-in profile's, read by the same http source", () => {
    expect(findBuiltinProfile("dora")).toBe(DORA_PROFILE);
    expect(DORA_PROFILE.wire).toBe(DORA_WIRE);
    expect(DORA_PROFILE.evidenceSources.map((s) => s.id)).toEqual(["poppo_http"]);
  });

  it("projects the caller's fields from request.decoded, keeps the route and leaves the replay out", async () => {
    const snapshot = await buildSnapshot({ files: [write("a.jsonl", SESSION)], policy: DORA_WIRE });

    expect(snapshot.stats.replays).toBe(1);
    expect(snapshot.records.map((r) => [r.path, r.route ?? null, r.fields])).toEqual([
      ["/user-service/api/user/card", null, [["target", "7"]]],
      ["/common-service/api/route", "lang/list", [["lang", "en"]]],
      ["/common-service/api/route", "version/check-version", [["build", "497"]]],
      ["/user-service/api/user/edit", null, [["nickname", "Ann"]]],
    ]);
    expect(snapshot.records[3]?.encrypted).toBe(true);
    // rev6 says so: `_sign` is no encryption marker on this wire.
    expect(snapshot.records[0]?.encrypted).toBe(false);
  });

  it("with Poppo's wire the same POST bodies would carry no fields and the globals would leak in", async () => {
    const snapshot = await buildSnapshot({ files: [write("a.jsonl", SESSION)] });
    const route = snapshot.records.find((r) => r.route === "lang/list");
    expect(route?.fields.map(([k]) => k)).toEqual(
      expect.arrayContaining(["tz", "n", "requestId", "emulator_score"]),
    );
  });

  it("compares two runs by route with the volatile parameters ignored", async () => {
    const baseline = await buildSnapshot({ files: [write("b.jsonl", SESSION)], policy: DORA_WIRE });
    const changed = SESSION.map((s) =>
      s.seq === 3
        ? { ...s, decoded: { build: 498 }, requestId: "other" }
        : { ...s, requestId: `x${s.seq}` },
    );
    const capture = await buildSnapshot({ files: [write("c.jsonl", changed)], policy: DORA_WIRE });
    const readers = readersFor(DORA_WIRE);
    const parse = (records: typeof baseline.records) =>
      records.map((r) => readers.capture(JSON.parse(JSON.stringify(r))));

    const result = compareProjections(parse(baseline.records), parse(capture.records), {
      policy: DORA_WIRE,
    });

    expect(result.groups.map((g) => [g.group, g.status])).toEqual([
      ["GET /user-service/api/user/card []", "MATCH"],
      ["POST /common-service/api/route [route=lang/list]", "MATCH"],
      ["POST /common-service/api/route [route=version/check-version]", "CHANGED"],
      ["POST /user-service/api/user/edit []", "MATCH"],
    ]);
    expect(parse(baseline.records)[0]?.deviceHeaders).toBe(true);
  });

  it("Poppo's readers ignore Dora's headers, as baseline_diff.py does", async () => {
    const snapshot = await buildSnapshot({ files: [write("a.jsonl", SESSION)], policy: DORA_WIRE });
    expect(fromCapture(JSON.parse(JSON.stringify(snapshot.records[0]))).deviceHeaders).toBe(false);
  });
});

describe("which wire a tool reads with", () => {
  it("is the named profile's, else Poppo's; an unknown name is an argument error", async () => {
    expect(await resolveWire("dora", undefined)).toEqual({ profile: "dora", policy: DORA_WIRE });
    expect(await resolveWire(undefined, undefined)).toEqual({ profile: null, policy: POPPO_WIRE });
    await expect(resolveWire("nope", undefined)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
});
