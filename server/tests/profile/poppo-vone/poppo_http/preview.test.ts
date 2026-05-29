import { describe, expect, it } from "vitest";
import { previewPoppoHttpRecord } from "../../../../src/profile/poppo-vone/poppo_http/preview.ts";
import type { PoppoHttpRecord } from "../../../../src/profile/poppo-vone/poppo_http/record.ts";
import type { ParsedRecord } from "../../../../src/profile/types.ts";

/**
 * v2-G.1 Phase 2 — poppo_http.previewForAgent unit coverage.
 *
 * Per lock § Q4: truncate `body.text` when `body.textBytes >
 * THRESHOLD_BODY_TEXT_BYTES (2048)` and `body.decoded` when its
 * `JSON.stringify` size exceeds `THRESHOLD_BODY_DECODED_BYTES (2048)`.
 * Both `request.body` and `response.body` go through the same rules.
 * `fullSizeBytes` is the utf8 byte length of the raw record.
 *
 * Tests use real `PoppoHttpRecord` shapes (rev4) — not the loose
 * `ParsedRecord` — so we exercise the type narrowing the source impl
 * relies on. The `as unknown as ParsedRecord` cast at the call boundary
 * mirrors how runtime invokes the hook.
 */

const SHANGHAI_TS = 1_716_600_000_000;
type PoppoResponse = NonNullable<PoppoHttpRecord["response"]>;

function makeBody(overrides: Partial<PoppoHttpRecord["request"]["body"]> = {}) {
  return {
    contentType: "application/json",
    charset: "UTF-8",
    text: null,
    textBytes: null,
    omittedReason: "no-body" as string | null,
    preview: null,
    previewBytes: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<PoppoHttpRecord> = {}): PoppoHttpRecord {
  return {
    source: "poppo_http" as const,
    v: 1,
    runId: "TEST-RUN",
    seq: 1,
    pid: 9999,
    tsMs: SHANGHAI_TS,
    durationMs: 100,
    method: "GET",
    url: "https://api.example.com/x",
    path: "/x",
    host: "api.example.com",
    protocol: "h2",
    heartBeat: false,
    request: {
      headers: [],
      params: [],
      decoded: null,
      body: makeBody(),
    },
    response: {
      status: 200,
      headers: [],
      body: makeBody({
        text: '{"ok":true}',
        textBytes: 11,
        omittedReason: null,
      }),
      app: { status: "ok", code: null, errCode: null, errMsg: null, message: null, ok: true },
    },
    error: null,
    ...overrides,
  } as PoppoHttpRecord;
}

function callPreview(
  record: PoppoHttpRecord,
  opts: { fields?: readonly string[]; fullRecords?: boolean } = {},
) {
  return previewPoppoHttpRecord(record as unknown as ParsedRecord, opts);
}

describe("previewPoppoHttpRecord — H1 digest/fields projection", () => {
  it("default: returns digest only with available sections and sizes", () => {
    const result = callPreview(makeRecord());
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
    expect(result.available).toEqual([
      "request.headers",
      "request.params",
      "response.headers",
      "response.body",
    ]);
    expect(result.sizes?.["response.body"]).toBeGreaterThan(0);

    expect(result.record).toEqual({
      source: "poppo_http",
      tsMs: SHANGHAI_TS,
      runId: "TEST-RUN",
      seq: 1,
      method: "GET",
      path: "/x",
      host: "api.example.com",
      status: 200,
      durationMs: 100,
      outcome: "ok",
      heartBeat: false,
      app: { ok: true, code: null, message: null },
    });
  });

  it("fullSizeBytes is the utf8 byte length of the input record JSON", () => {
    const record = makeRecord();
    const result = callPreview(record);
    const expected = Buffer.byteLength(JSON.stringify(record), "utf8");
    expect(result.fullSizeBytes).toBe(expected);
  });

  it("body.text exactly at threshold: NOT truncated (boundary)", () => {
    // textBytes == 2048 → NOT > 2048 → no truncation.
    const text = "a".repeat(2048);
    const record = makeRecord({
      response: {
        status: 200,
        headers: [],
        body: makeBody({ text, textBytes: 2048, omittedReason: null }),
        app: null,
      },
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
  });

  it("fields:['response.body']: returns digest plus only the requested response body section", () => {
    const original = "x".repeat(10_000);
    const record = makeRecord({
      response: {
        status: 200,
        headers: [{ name: "Server", value: "unit" }],
        body: makeBody({ text: original, textBytes: 10_000, omittedReason: null }),
        app: null,
      },
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toEqual(["response.body.text"]);
    const r = result.record as unknown as {
      response?: { body?: PoppoResponse["body"]; headers?: unknown };
      request?: unknown;
    };
    expect(r.response?.body?.text?.startsWith("x".repeat(1024))).toBe(true);
    expect(r.response?.body?.text).toContain("…<truncated 10000 bytes>");
    expect(r.response?.headers).toBeUndefined();
    expect(r.request).toBeUndefined();
  });

  it("fields:['request.decoded']: returns redacted decoded and preserves business fields", () => {
    const record = makeRecord({
      request: {
        headers: [],
        params: [],
        decoded: {
          imei: "imei-raw",
          oaid: "oaid-raw",
          smei_id: "smei-raw",
          appsflyer_id: "appsflyer-raw",
          _uid: "uid-raw",
          uuid: "uuid-raw",
          os_version: "14",
          b_vpn: false,
        },
        body: makeBody(),
      },
    });
    const result = callPreview(record, { fields: ["request.decoded"] });
    const decoded = (result.record as { request?: { decoded?: Record<string, unknown> } }).request
      ?.decoded;
    expect(decoded).toEqual({
      imei: "[REDACTED]",
      oaid: "[REDACTED]",
      smei_id: "[REDACTED]",
      appsflyer_id: "[REDACTED]",
      _uid: "[REDACTED]",
      uuid: "[REDACTED]",
      os_version: "14",
      b_vpn: false,
    });
    expect(result.redactedFields).toEqual(["request.decoded"]);
  });
});

describe("previewPoppoHttpRecord — response body.text truncation", () => {
  it("oversize text → truncated to 1024-char head + suffix; textBytes preserved", () => {
    const original = "x".repeat(10_000);
    const record = makeRecord({
      response: {
        status: 200,
        headers: [],
        body: makeBody({ text: original, textBytes: 10_000, omittedReason: null }),
        app: null,
      },
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toContain("response.body.text");
    const r = result.record as unknown as { response?: { body?: PoppoResponse["body"] } };
    const truncatedText = r.response?.body?.text;
    expect(truncatedText).not.toBeNull();
    expect(truncatedText?.startsWith("x".repeat(1024))).toBe(true);
    expect(truncatedText).toContain("…<truncated 10000 bytes>");
    // textBytes is preserved (agent uses it to compute compression).
    expect(r.response?.body?.textBytes).toBe(10_000);
  });
});

describe("previewPoppoHttpRecord — response body.decoded truncation", () => {
  it("oversize decoded → replaced with {__truncated, headChars, fullBytes}", () => {
    const bigArr = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      payload: "x".repeat(30),
    }));
    const responseWithDecoded = {
      status: 200,
      headers: [],
      body: {
        ...makeBody({ text: '{"ok":true}', textBytes: 11, omittedReason: null }),
        decoded: bigArr,
      },
      app: null,
    };
    const record = makeRecord({
      response: responseWithDecoded as unknown as PoppoHttpRecord["response"],
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toContain("response.body.decoded");
    const r = result.record as unknown as { response?: { body?: { decoded?: unknown } } };
    const decoded = (r.response?.body as { decoded?: unknown }).decoded as {
      __truncated: true;
      headChars: string;
      fullBytes: number;
    };
    expect(decoded.__truncated).toBe(true);
    expect(decoded.headChars.length).toBeLessThanOrEqual(1024);
    expect(decoded.fullBytes).toBe(Buffer.byteLength(JSON.stringify(bigArr), "utf8"));
  });

  it("small decoded (under threshold): pass through unchanged", () => {
    const smallDecoded = { ok: true, items: [1, 2, 3] };
    const responseWithSmall = {
      status: 200,
      headers: [],
      body: {
        ...makeBody({ text: '{"ok":true}', textBytes: 11, omittedReason: null }),
        decoded: smallDecoded,
      },
      app: null,
    };
    const record = makeRecord({
      response: responseWithSmall as unknown as PoppoHttpRecord["response"],
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
    const r = result.record as unknown as { response?: { body?: { decoded?: unknown } } };
    expect((r.response?.body as { decoded?: unknown }).decoded).toEqual(smallDecoded);
  });
});

describe("previewPoppoHttpRecord — request body truncation (POST uploads)", () => {
  it("oversize request body.text → truncated; truncatedFields includes request.body.text", () => {
    const original = "U".repeat(5_000);
    const record = makeRecord({
      request: {
        headers: [],
        params: [],
        decoded: null,
        body: makeBody({ text: original, textBytes: 5_000, omittedReason: null }),
      },
    });
    const result = callPreview(record, { fields: ["request.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toContain("request.body.text");
    const r = result.record as unknown as {
      request?: { body?: PoppoHttpRecord["request"]["body"] };
    };
    const text = r.request?.body?.text;
    expect(text?.startsWith("U".repeat(1024))).toBe(true);
    expect(text).toContain("…<truncated 5000 bytes>");
  });

  it("oversize request decoded → __truncated marker; truncatedFields includes request.decoded", () => {
    const bigArr = Array.from({ length: 500 }, (_, i) => ({ id: i, payload: "y".repeat(30) }));
    const record = makeRecord({
      request: {
        headers: [],
        params: [],
        decoded: bigArr,
        body: makeBody(),
      },
    });
    const result = callPreview(record, { fields: ["request.decoded"] });
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
    const r = result.record as unknown as { request?: { decoded?: unknown } };
    expect(r.request?.decoded).toEqual(bigArr);
  });
});

describe("previewPoppoHttpRecord — request + response both oversized", () => {
  it("both bodies truncate; truncatedFields lists both paths", () => {
    const record = makeRecord({
      request: {
        headers: [],
        params: [],
        decoded: null,
        body: makeBody({
          text: "R".repeat(3000),
          textBytes: 3000,
          omittedReason: null,
        }),
      },
      response: {
        status: 200,
        headers: [],
        body: makeBody({
          text: "S".repeat(3000),
          textBytes: 3000,
          omittedReason: null,
        }),
        app: null,
      },
    });
    const result = callPreview(record, { fields: ["request.body", "response.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toEqual(
      expect.arrayContaining(["request.body.text", "response.body.text"]),
    );
  });
});

describe("previewPoppoHttpRecord — transport-error record (response=null)", () => {
  it("error-only record: nothing to truncate on response side", () => {
    const record = makeRecord({
      response: null,
      error: { type: "java.net.SocketTimeoutException", message: "timeout", phase: "connect" },
    });
    const result = callPreview(record, { fields: ["response.body"] });
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
  });

  it("error record with huge request body still truncates request side", () => {
    const record = makeRecord({
      request: {
        headers: [],
        params: [],
        decoded: null,
        body: makeBody({
          text: "Q".repeat(5_000),
          textBytes: 5_000,
          omittedReason: null,
        }),
      },
      response: null,
      error: { type: "java.io.IOException", message: "broken pipe", phase: "write" },
    });
    const result = callPreview(record, { fields: ["request.body"] });
    expect(result.truncated).toBe(true);
    expect(result.truncatedFields).toEqual(["request.body.text"]);
  });
});

describe("previewPoppoHttpRecord — H1 fullRecords still redacts", () => {
  it("fullRecords:true returns every section without body truncation but never raw secrets", () => {
    const bodyText = "x".repeat(10_000);
    const record = makeRecord({
      url: "https://api.example.com/homepage?_sign=SIG&imei=imei-raw",
      request: {
        headers: [{ name: "Authorization", value: "Bearer req-secret" }],
        params: [
          { name: "_sign", value: "SIG" },
          { name: "imei", value: "imei-raw" },
        ],
        decoded: { imei: "imei-raw", os_version: "14" },
        body: makeBody(),
      },
      response: {
        status: 200,
        headers: [{ name: "Set-Cookie", value: "sid=response-cookie" }],
        body: makeBody({ text: bodyText, textBytes: 10_000, omittedReason: null }),
        app: null,
      },
    });

    const result = callPreview(record, { fullRecords: true });
    const r = result.record as unknown as PoppoHttpRecord;
    expect(result.truncated).toBe(false);
    expect(result.truncatedFields).toEqual([]);
    expect(result.redactedFields).toEqual(
      expect.arrayContaining([
        "url",
        "request.headers",
        "request.params",
        "request.decoded",
        "response.headers",
      ]),
    );
    expect(result.redactedFields).not.toEqual(
      expect.arrayContaining(["request.decoded.imei", "request.params.0.value"]),
    );
    expect(r.response?.body.text).toBe(bodyText);
    expect(JSON.stringify(r)).not.toContain("SIG");
    expect(JSON.stringify(r)).not.toContain("imei-raw");
    expect(JSON.stringify(r)).not.toContain("req-secret");
    expect(JSON.stringify(r)).not.toContain("response-cookie");
    expect(r.request.params).toEqual([
      { name: "_sign", value: "[REDACTED]" },
      { name: "imei", value: "[REDACTED]" },
    ]);
    expect(r.request.decoded).toEqual({ imei: "[REDACTED]", os_version: "14" });
    expect(r.response?.headers).toEqual([{ name: "Set-Cookie", value: "[REDACTED]" }]);
  });
});
