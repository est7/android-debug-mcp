import { describe, expect, it } from "vitest";
import {
  MAX_REDACT_DEPTH,
  REDACTED,
  isSensitiveKey,
  redactValue,
} from "../../src/redact/redact.ts";

describe("isSensitiveKey", () => {
  it.each([
    "password",
    "Password",
    "PASSWORD",
    "userPassword",
    "user_password",
    "Authorization",
    "x-auth-token",
    "access_token",
    "refreshToken",
    "tokenizer", // accepted over-redaction
    "Cookie",
    "set-cookie",
    "otp",
    "otpCode",
    "verification",
    "verificationCode",
  ])("flags %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["username", "email", "deviceSerial", "runId", "status", "count", "name"])(
    "leaves %s untouched",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redactValue", () => {
  it("redacts a sensitive top-level key", () => {
    expect(redactValue({ password: "hunter2", user: "alice" })).toEqual({
      password: REDACTED,
      user: "alice",
    });
  });

  it("redacts nested sensitive keys", () => {
    const input = { headers: { Authorization: "Bearer abc", host: "x" }, ok: true };
    expect(redactValue(input)).toEqual({
      headers: { Authorization: REDACTED, host: "x" },
      ok: true,
    });
  });

  it("redacts sensitive keys inside arrays", () => {
    expect(redactValue([{ cookie: "a" }, { cookie: "b" }])).toEqual([
      { cookie: REDACTED },
      { cookie: REDACTED },
    ]);
  });

  it("passes scalars through unchanged", () => {
    expect(redactValue("plain")).toBe("plain");
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
  });

  it("does not mutate the input object", () => {
    const input = { password: "secret" };
    redactValue(input);
    expect(input.password).toBe("secret");
  });

  it("replaces subtrees past MAX_REDACT_DEPTH with a marker", () => {
    // Build an object nested deeper than the limit.
    let deep: Record<string, unknown> = { token: "leaf" };
    for (let i = 0; i < MAX_REDACT_DEPTH + 3; i++) deep = { nested: deep };
    const out = JSON.stringify(redactValue(deep));
    expect(out).toContain("redact:max-depth");
  });

  it("redacts a value whose key is sensitive even when the value is an object", () => {
    expect(redactValue({ token: { nested: "still-secret" } })).toEqual({ token: REDACTED });
  });
});
