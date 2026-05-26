import { describe, expect, it } from "vitest";
import { parsePoppoHttpLine } from "../../../../src/profile/poppo-vone/poppo_http/record.ts";

/**
 * Schema rev4 fixture coverage. The 3 examples here are copied verbatim
 * (formatted onto one line each) from `submodulepoppo/docs/projects/
 * http-log-jsonl-schema.md` § 示例. They are the authoritative wire-shape
 * fixtures for this reader; do not edit without updating the schema doc.
 */

const HEARTBEAT_OK_RECORD = JSON.stringify({
  v: 1,
  runId: "1779260470000_18866",
  seq: 35,
  pid: 18866,
  tsMs: 1779260473246,
  durationMs: 316,
  method: "GET",
  url: "https://test-api-global.v.show/user/info?_uid=37142512",
  path: "/user/info",
  host: "test-api-global.v.show",
  protocol: "h2",
  heartBeat: true,
  request: {
    headers: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
    params: [{ name: "_uid", value: "37142512" }],
    decoded: { infos: "heart_beat|feedback_setting_draw" },
    body: {
      contentType: null,
      charset: null,
      text: null,
      textBytes: null,
      omittedReason: "no-body",
      preview: null,
      previewBytes: null,
    },
  },
  response: {
    status: 200,
    headers: [{ name: "Server", value: "nginx/1.18.0" }],
    body: {
      contentType: "application/json",
      charset: "UTF-8",
      text: '{"status":"ok"}',
      textBytes: 15,
      omittedReason: null,
      preview: null,
      previewBytes: null,
    },
    app: {
      status: "ok",
      code: null,
      errCode: null,
      errMsg: null,
      message: null,
      ok: true,
    },
  },
  error: null,
});

const APP_ERROR_RECORD = JSON.stringify({
  v: 1,
  runId: "1779260470000_18866",
  seq: 37,
  pid: 18866,
  tsMs: 1779260485100,
  durationMs: 120,
  method: "POST",
  url: "https://test-api-global.v.show/user/login",
  path: "/user/login",
  host: "test-api-global.v.show",
  protocol: "h2",
  heartBeat: false,
  request: {
    headers: [{ name: "Content-Type", value: "application/json" }],
    params: [],
    decoded: null,
    body: {
      contentType: "application/json",
      charset: "UTF-8",
      text: '{"account":"x"}',
      textBytes: 15,
      omittedReason: null,
      preview: null,
      previewBytes: null,
    },
  },
  response: {
    status: 200,
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: {
      contentType: "application/json",
      charset: "UTF-8",
      text: '{"status":"err","code":4001,"err_code":"4001","err_msg":"wrong password"}',
      textBytes: 72,
      omittedReason: null,
      preview: null,
      previewBytes: null,
    },
    app: {
      status: "err",
      code: 4001,
      errCode: "4001",
      errMsg: "wrong password",
      message: null,
      ok: false,
    },
  },
  error: null,
});

const TRANSPORT_ERROR_RECORD = JSON.stringify({
  v: 1,
  runId: "1779260470000_18866",
  seq: 36,
  pid: 18866,
  tsMs: 1779260480001,
  durationMs: 30000,
  method: "GET",
  url: "https://test-api-global.v.show/system/skin",
  path: "/system/skin",
  host: "test-api-global.v.show",
  protocol: null,
  heartBeat: false,
  request: {
    headers: [],
    params: [],
    decoded: null,
    body: {
      contentType: null,
      charset: null,
      text: null,
      textBytes: null,
      omittedReason: "no-body",
      preview: null,
      previewBytes: null,
    },
  },
  response: null,
  error: {
    type: "java.net.SocketTimeoutException",
    message: "timeout",
    phase: "timeout",
  },
});

describe("parsePoppoHttpLine — accepts schema rev4 examples", () => {
  it("accepts the GET-success-heartbeat example", () => {
    const r = parsePoppoHttpLine(HEARTBEAT_OK_RECORD);
    expect(r).not.toBeNull();
    expect(r?.source).toBe("poppo_http");
    expect(r?.tsMs).toBe(1779260473246);
    expect(r?.response?.app?.ok).toBe(true);
    expect(r?.error).toBeNull();
  });

  it("accepts the HTTP-200-business-error example (status:err + app.ok:false)", () => {
    const r = parsePoppoHttpLine(APP_ERROR_RECORD);
    expect(r).not.toBeNull();
    expect(r?.response?.status).toBe(200);
    expect(r?.response?.app?.ok).toBe(false);
    expect(r?.response?.app?.code).toBe(4001);
  });

  it("accepts the transport-failure example (response:null, error populated)", () => {
    const r = parsePoppoHttpLine(TRANSPORT_ERROR_RECORD);
    expect(r).not.toBeNull();
    expect(r?.response).toBeNull();
    expect(r?.error?.type).toBe("java.net.SocketTimeoutException");
    expect(r?.error?.phase).toBe("timeout");
  });
});

describe("parsePoppoHttpLine — hard rejects + null returns", () => {
  it("hard-rejects unknown v (consumer MUST reject per schema § 兼容性规则)", () => {
    const bad = JSON.stringify({ ...JSON.parse(HEARTBEAT_OK_RECORD), v: 2 });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("returns null on malformed JSON (active-file half-line tolerance)", () => {
    expect(parsePoppoHttpLine('{"v":1,"runId":"x"')).toBeNull();
    expect(parsePoppoHttpLine("not json at all")).toBeNull();
  });

  it("returns null when both response and error are populated", () => {
    const bad = JSON.stringify({
      ...JSON.parse(HEARTBEAT_OK_RECORD),
      error: { type: "x", message: null, phase: null },
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("returns null when both response and error are null", () => {
    const bad = JSON.stringify({
      ...JSON.parse(HEARTBEAT_OK_RECORD),
      response: null,
      error: null,
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("returns null on missing required field (host)", () => {
    const parsed = JSON.parse(HEARTBEAT_OK_RECORD) as Record<string, unknown>;
    const { host: _omit, ...rest } = parsed;
    expect(parsePoppoHttpLine(JSON.stringify(rest))).toBeNull();
  });
});

describe("parsePoppoHttpLine — body invariants (codex Phase 4 audit V1)", () => {
  function mutateRequestBody(base: string, patch: (b: Record<string, unknown>) => void): string {
    const obj = JSON.parse(base) as Record<string, unknown>;
    const req = obj.request as Record<string, unknown>;
    const body = { ...(req.body as Record<string, unknown>) };
    patch(body);
    req.body = body;
    return JSON.stringify(obj);
  }

  it("I1: text != null but textBytes == null → null (parse failure)", () => {
    const bad = mutateRequestBody(APP_ERROR_RECORD, (b) => {
      b.textBytes = null;
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("I1: text == null but omittedReason == null → null", () => {
    const bad = mutateRequestBody(APP_ERROR_RECORD, (b) => {
      b.text = null;
      b.textBytes = null;
      b.omittedReason = null; // claim "complete body" but text is gone
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("I1: complete-body trio agrees → accepted", () => {
    // Sanity-check the positive side: APP_ERROR_RECORD's request body has all three.
    expect(parsePoppoHttpLine(APP_ERROR_RECORD)).not.toBeNull();
  });

  it('I2: preview != null with omittedReason != "oversize" → null', () => {
    const bad = mutateRequestBody(HEARTBEAT_OK_RECORD, (b) => {
      b.omittedReason = "binary";
      b.preview = "head bytes";
      b.previewBytes = 10;
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it('I2: preview != null with omittedReason == "oversize" → accepted', () => {
    const good = mutateRequestBody(HEARTBEAT_OK_RECORD, (b) => {
      b.omittedReason = "oversize";
      b.text = null;
      b.textBytes = null;
      b.preview = "head bytes";
      b.previewBytes = 10;
    });
    expect(parsePoppoHttpLine(good)).not.toBeNull();
  });

  it("I3: preview != null but previewBytes == null → null", () => {
    const bad = mutateRequestBody(HEARTBEAT_OK_RECORD, (b) => {
      b.omittedReason = "oversize";
      b.text = null;
      b.textBytes = null;
      b.preview = "head bytes";
      b.previewBytes = null;
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it("I3: previewBytes != null but preview == null → null", () => {
    const bad = mutateRequestBody(HEARTBEAT_OK_RECORD, (b) => {
      b.omittedReason = "oversize";
      b.text = null;
      b.textBytes = null;
      b.preview = null;
      b.previewBytes = 10;
    });
    expect(parsePoppoHttpLine(bad)).toBeNull();
  });

  it('oversize with both preview fields null → accepted (preview "necessary not sufficient")', () => {
    // Schema § preview 语义: oversize may legitimately have preview === null
    // (encrypted/non-UTF-8 head). The invariant only forbids preview without
    // omittedReason==oversize; the reverse is allowed.
    const good = mutateRequestBody(HEARTBEAT_OK_RECORD, (b) => {
      b.omittedReason = "oversize";
      b.text = null;
      b.textBytes = null;
      b.preview = null;
      b.previewBytes = null;
    });
    expect(parsePoppoHttpLine(good)).not.toBeNull();
  });
});

describe("parsePoppoHttpLine — passthrough tolerance for forward-compat fields", () => {
  it("tolerates unknown top-level keys (consumer ignores unknown)", () => {
    const withExtra = JSON.stringify({
      ...JSON.parse(HEARTBEAT_OK_RECORD),
      futureField: { added: "in a later rev" },
    });
    expect(parsePoppoHttpLine(withExtra)).not.toBeNull();
  });

  it("tolerates unknown nested keys (e.g. on body)", () => {
    const obj = JSON.parse(HEARTBEAT_OK_RECORD) as Record<string, unknown>;
    const req = obj.request as Record<string, unknown>;
    const body = req.body as Record<string, unknown>;
    body.futureFlag = true;
    expect(parsePoppoHttpLine(JSON.stringify(obj))).not.toBeNull();
  });

  it("tolerates an unknown omittedReason value (treated as opaque string)", () => {
    const obj = JSON.parse(HEARTBEAT_OK_RECORD) as Record<string, unknown>;
    const req = obj.request as Record<string, unknown>;
    const body = req.body as Record<string, unknown>;
    body.omittedReason = "client-prefetch-future-value";
    const r = parsePoppoHttpLine(JSON.stringify(obj));
    expect(r).not.toBeNull();
    expect(r?.request.body.omittedReason).toBe("client-prefetch-future-value");
  });

  it("tolerates an unknown error.phase value", () => {
    const obj = JSON.parse(TRANSPORT_ERROR_RECORD) as Record<string, unknown>;
    const err = obj.error as Record<string, unknown>;
    err.phase = "tls-handshake-future-value";
    const r = parsePoppoHttpLine(JSON.stringify(obj));
    expect(r).not.toBeNull();
    expect(r?.error?.phase).toBe("tls-handshake-future-value");
  });
});
