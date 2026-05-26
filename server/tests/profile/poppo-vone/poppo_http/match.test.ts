import { describe, expect, it } from "vitest";
import {
  type PoppoHttpQuery,
  derivePoppoHttpOutcome,
  matchPoppoHttpRecord,
} from "../../../../src/profile/poppo-vone/poppo_http/match.ts";
import type { PoppoHttpRecord } from "../../../../src/profile/poppo-vone/poppo_http/record.ts";

/**
 * Convenience: build a minimal valid record by spreading overrides on a
 * baseline. The baseline is an HTTP-200 + app.ok:true record; tests flip
 * the fields they care about.
 */
function rec(overrides: Partial<PoppoHttpRecord> & Record<string, unknown> = {}): PoppoHttpRecord {
  const base: PoppoHttpRecord = {
    source: "poppo_http",
    v: 1,
    runId: "r1",
    seq: 1,
    pid: 100,
    tsMs: 1_000_000,
    durationMs: 50,
    method: "GET",
    url: "https://api.example.com/users/profile",
    path: "/users/profile",
    host: "api.example.com",
    protocol: "h2",
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
    response: {
      status: 200,
      headers: [],
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
  };
  return { ...base, ...overrides } as PoppoHttpRecord;
}

describe("derivePoppoHttpOutcome — codex audit R4 cascade", () => {
  it("transport_error when error != null", () => {
    const r = rec({
      response: null,
      error: { type: "java.net.SocketTimeoutException", message: "timeout", phase: "timeout" },
    });
    expect(derivePoppoHttpOutcome(r)).toBe("transport_error");
  });

  it("http_error when status non-2xx (regardless of app.ok)", () => {
    const r = rec({
      response: {
        status: 500,
        headers: [],
        body: {
          contentType: "application/json",
          charset: "UTF-8",
          text: '{"status":"err"}',
          textBytes: 16,
          omittedReason: null,
          preview: null,
          previewBytes: null,
        },
        app: {
          status: "err",
          code: 500,
          errCode: null,
          errMsg: null,
          message: null,
          ok: false,
        },
      },
    });
    // CRITICAL: HTTP 500 + app.ok:false → http_error wins (codex R4)
    expect(derivePoppoHttpOutcome(r)).toBe("http_error");
  });

  it("app_error when status === 200 and app.ok === false", () => {
    const r = rec({
      response: {
        status: 200,
        headers: [],
        body: {
          contentType: "application/json",
          charset: "UTF-8",
          text: '{"status":"err","code":4001}',
          textBytes: 28,
          omittedReason: null,
          preview: null,
          previewBytes: null,
        },
        app: {
          status: "err",
          code: 4001,
          errCode: "4001",
          errMsg: "bad password",
          message: null,
          ok: false,
        },
      },
    });
    expect(derivePoppoHttpOutcome(r)).toBe("app_error");
  });

  it("ok for vanilla 200 + app.ok:true", () => {
    expect(derivePoppoHttpOutcome(rec())).toBe("ok");
  });

  it("ok for 200 with no app envelope (resource endpoint)", () => {
    const r = rec({
      response: {
        status: 200,
        headers: [],
        body: {
          contentType: "image/png",
          charset: null,
          text: null,
          textBytes: null,
          omittedReason: "binary",
          preview: null,
          previewBytes: null,
        },
        app: null,
      },
    });
    expect(derivePoppoHttpOutcome(r)).toBe("ok");
  });
});

describe("matchPoppoHttpRecord — independent filters", () => {
  it("pathPrefix matches as prefix only", () => {
    const q: PoppoHttpQuery = { source: "poppo_http", pathPrefix: "/users" };
    expect(matchPoppoHttpRecord(rec({ path: "/users/profile" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ path: "/users" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ path: "/other/users" }), q)).toBe(false);
  });

  it("methodIn whitelist", () => {
    const q: PoppoHttpQuery = { source: "poppo_http", methodIn: ["POST", "PUT"] };
    expect(matchPoppoHttpRecord(rec({ method: "POST" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ method: "PUT" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ method: "GET" }), q)).toBe(false);
  });

  it("excludeHeartbeat opts IN — default behaviour does NOT filter heartbeats", () => {
    const heartbeat = rec({ heartBeat: true });
    expect(matchPoppoHttpRecord(heartbeat, { source: "poppo_http" })).toBe(true);
    expect(matchPoppoHttpRecord(heartbeat, { source: "poppo_http", excludeHeartbeat: true })).toBe(
      false,
    );
    expect(matchPoppoHttpRecord(heartbeat, { source: "poppo_http", excludeHeartbeat: false })).toBe(
      true,
    );
  });

  it("tsMsRange inclusive on both bounds", () => {
    const q: PoppoHttpQuery = {
      source: "poppo_http",
      tsMsRange: { from: 1_000_000, to: 2_000_000 },
    };
    expect(matchPoppoHttpRecord(rec({ tsMs: 1_000_000 }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ tsMs: 1_500_000 }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ tsMs: 2_000_000 }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ tsMs: 999_999 }), q)).toBe(false);
    expect(matchPoppoHttpRecord(rec({ tsMs: 2_000_001 }), q)).toBe(false);
  });

  it("hostContains substring on host (not path / not url)", () => {
    const q: PoppoHttpQuery = { source: "poppo_http", hostContains: "test-api" };
    expect(matchPoppoHttpRecord(rec({ host: "test-api.example.com" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ host: "prod-api.example.com" }), q)).toBe(false);
  });

  it("durationMsGte ≥ inclusive", () => {
    const q: PoppoHttpQuery = { source: "poppo_http", durationMsGte: 500 };
    expect(matchPoppoHttpRecord(rec({ durationMs: 500 }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ durationMs: 1000 }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ durationMs: 499 }), q)).toBe(false);
  });

  it("errorTypeIn — only matches when record has error AND type is in whitelist", () => {
    const q: PoppoHttpQuery = {
      source: "poppo_http",
      errorTypeIn: ["java.net.SocketTimeoutException"],
    };
    const transport = rec({
      response: null,
      error: { type: "java.net.SocketTimeoutException", message: "x", phase: "timeout" },
    });
    expect(matchPoppoHttpRecord(transport, q)).toBe(true);
    const wrongType = rec({
      response: null,
      error: { type: "java.io.IOException", message: "x", phase: "read" },
    });
    expect(matchPoppoHttpRecord(wrongType, q)).toBe(false);
    // A successful record has error===null, so errorTypeIn excludes it.
    expect(matchPoppoHttpRecord(rec(), q)).toBe(false);
  });

  it("outcome === 'http_error' (HTTP 500 + app.ok:false) — pinned R4 cascade", () => {
    const r = rec({
      response: {
        status: 500,
        headers: [],
        body: {
          contentType: "application/json",
          charset: "UTF-8",
          text: '{"status":"err"}',
          textBytes: 16,
          omittedReason: null,
          preview: null,
          previewBytes: null,
        },
        app: {
          status: "err",
          code: null,
          errCode: null,
          errMsg: null,
          message: null,
          ok: false,
        },
      },
    });
    expect(matchPoppoHttpRecord(r, { source: "poppo_http", outcome: "http_error" })).toBe(true);
    expect(matchPoppoHttpRecord(r, { source: "poppo_http", outcome: "app_error" })).toBe(false);
  });
});

describe("matchPoppoHttpRecord — composed AND semantics", () => {
  it("two filters compose as AND", () => {
    const q: PoppoHttpQuery = {
      source: "poppo_http",
      pathPrefix: "/users",
      methodIn: ["POST"],
    };
    expect(matchPoppoHttpRecord(rec({ path: "/users/login", method: "POST" }), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ path: "/users/login", method: "GET" }), q)).toBe(false);
    expect(matchPoppoHttpRecord(rec({ path: "/other", method: "POST" }), q)).toBe(false);
  });

  it("empty query (only source) matches everything", () => {
    const q: PoppoHttpQuery = { source: "poppo_http" };
    expect(matchPoppoHttpRecord(rec(), q)).toBe(true);
    expect(matchPoppoHttpRecord(rec({ heartBeat: true }), q)).toBe(true);
  });
});
