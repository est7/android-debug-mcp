import { describe, expect, it } from "vitest";
import type { PoppoHttpRecord } from "../../../../src/profile/poppo-vone/poppo_http/record.ts";
import { redactPoppoHttpRecord } from "../../../../src/profile/poppo-vone/poppo_http/redact.ts";

function rec(overrides: Partial<PoppoHttpRecord> = {}): PoppoHttpRecord {
  const base: PoppoHttpRecord = {
    source: "poppo_http",
    v: 1,
    runId: "r1",
    seq: 1,
    pid: 100,
    tsMs: 1_000_000,
    durationMs: 50,
    method: "GET",
    url: "https://api.example.com/users",
    path: "/users",
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
        text: '{"k":"v"}',
        textBytes: 9,
        omittedReason: null,
        preview: null,
        previewBytes: null,
      },
      app: null,
    },
    error: null,
  };
  return { ...base, ...overrides } as PoppoHttpRecord;
}

describe("redactPoppoHttpRecord — header value masking", () => {
  it("masks Authorization value (case-insensitive)", () => {
    const r = rec({
      request: {
        ...rec().request,
        headers: [
          { name: "Authorization", value: "Bearer abc123" },
          { name: "Content-Type", value: "application/json" },
        ],
      },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.request.headers).toEqual([
      { name: "Authorization", value: "[REDACTED]" },
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("masks Cookie / Set-Cookie / Set-Cookie2 / Proxy-Authorization", () => {
    const r = rec({
      request: {
        ...rec().request,
        headers: [
          { name: "cookie", value: "session=abc" },
          { name: "PROXY-AUTHORIZATION", value: "Basic def" },
        ],
      },
      response: {
        // biome-ignore lint/style/noNonNullAssertion: rec() baseline always sets response.
        ...rec().response!,
        headers: [
          { name: "set-cookie", value: "a=1" },
          { name: "Set-Cookie2", value: "b=2" },
          { name: "Server", value: "nginx/1.18" },
        ],
      },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.request.headers).toEqual([
      { name: "cookie", value: "[REDACTED]" },
      { name: "PROXY-AUTHORIZATION", value: "[REDACTED]" },
    ]);
    expect(out.response?.headers).toEqual([
      { name: "set-cookie", value: "[REDACTED]" },
      { name: "Set-Cookie2", value: "[REDACTED]" },
      { name: "Server", value: "nginx/1.18" },
    ]);
  });

  it("redacts both request and response headers (codex Phase 4 audit Z)", () => {
    const r = rec({
      request: {
        ...rec().request,
        headers: [{ name: "Authorization", value: "secret-req" }],
      },
      response: {
        // biome-ignore lint/style/noNonNullAssertion: rec() baseline always sets response.
        ...rec().response!,
        headers: [{ name: "Authorization", value: "secret-resp" }],
      },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.request.headers[0]?.value).toBe("[REDACTED]");
    expect(out.response?.headers[0]?.value).toBe("[REDACTED]");
  });
});

describe("redactPoppoHttpRecord — query param masking", () => {
  it("masks signature, stable user, and device identifiers in request.params", () => {
    const r = rec({
      request: {
        ...rec().request,
        params: [
          { name: "_uid", value: "12345" },
          { name: "_sign", value: "deadbeef" },
          { name: "_random", value: "abc123" },
          { name: "smei_id", value: "device-a" },
          { name: "uuid", value: "9906b0cc-1111-2222-3333-444455556666" },
          { name: "foo", value: "bar" },
        ],
      },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.request.params).toEqual([
      { name: "_uid", value: "[REDACTED]" },
      { name: "_sign", value: "[REDACTED]" },
      { name: "_random", value: "[REDACTED]" },
      { name: "smei_id", value: "[REDACTED]" },
      { name: "uuid", value: "[REDACTED]" },
      { name: "foo", value: "bar" },
    ]);
  });
});

describe("redactPoppoHttpRecord — URL reconstruction", () => {
  it("reconstructs URL with scheme + port + dup params (codex audit R3 fixture)", () => {
    const r = rec({
      url: "https://h:8443/p?a=1&_sign=x&_uid=123&smei_id=device-a&uuid=9906b0cc&a=2",
      host: "h:8443",
      path: "/p",
      request: {
        ...rec().request,
        params: [
          { name: "a", value: "1" },
          { name: "_sign", value: "x" },
          { name: "_uid", value: "123" },
          { name: "smei_id", value: "device-a" },
          { name: "uuid", value: "9906b0cc" },
          { name: "a", value: "2" },
        ],
      },
    });
    const out = redactPoppoHttpRecord(r);
    // URL-encoded placeholder (codex audit #5).
    expect(out.url).toBe(
      "https://h:8443/p?a=1&_sign=%5BREDACTED%5D&_uid=%5BREDACTED%5D&smei_id=%5BREDACTED%5D&uuid=%5BREDACTED%5D&a=2",
    );
    // Original params list — sensitive values redacted; duplicate `a` order preserved.
    expect(out.request.params).toEqual([
      { name: "a", value: "1" },
      { name: "_sign", value: "[REDACTED]" },
      { name: "_uid", value: "[REDACTED]" },
      { name: "smei_id", value: "[REDACTED]" },
      { name: "uuid", value: "[REDACTED]" },
      { name: "a", value: "2" },
    ]);
  });

  it("preserves URL when no sensitive query params present", () => {
    const r = rec({ url: "https://api.example.com/users?id=42" });
    const out = redactPoppoHttpRecord(r);
    expect(out.url).toBe("https://api.example.com/users?id=42");
  });

  it("returns the URL unchanged when it is unparseable", () => {
    const garbage = "not a url at all _sign=abc";
    const r = rec({ url: garbage });
    const out = redactPoppoHttpRecord(r);
    expect(out.url).toBe(garbage);
  });
});

describe("redactPoppoHttpRecord — purity + scope", () => {
  it("does not mutate the input record", () => {
    const r = rec({
      request: {
        ...rec().request,
        headers: [{ name: "Authorization", value: "secret" }],
      },
    });
    redactPoppoHttpRecord(r);
    expect(r.request.headers[0]?.value).toBe("secret");
  });

  it("leaves body text / preview / decoded untouched (Q6 MVP scope)", () => {
    const r = rec({
      request: {
        ...rec().request,
        decoded: { sensitive: "stuff" },
        body: {
          ...rec().request.body,
          text: '{"password":"hunter2"}',
        },
      },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.request.decoded).toEqual({ sensitive: "stuff" });
    expect(out.request.body.text).toBe('{"password":"hunter2"}');
  });

  it("preserves response === null path (no error thrown)", () => {
    const r = rec({
      response: null,
      error: { type: "java.io.IOException", message: "x", phase: "read" },
    });
    const out = redactPoppoHttpRecord(r);
    expect(out.response).toBeNull();
    expect(out.error?.type).toBe("java.io.IOException");
  });
});
