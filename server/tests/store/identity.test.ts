import { describe, expect, it } from "vitest";
import {
  IdentityError,
  assertSafeDeviceSerial,
  assertSafePackageName,
  assertSafeRunId,
  assertSafeUserId,
} from "../../src/store/identity.ts";
import { mintRunId } from "../../src/store/runId.ts";

describe("assertSafePackageName", () => {
  it.each([
    ["com.example.app"],
    ["com.androidtool.test"],
    ["a.b"],
    ["a.b.c.d_e.f"],
    ["org.unicode.Long_NameWith2Numbers34"],
  ])("accepts valid package name %s", (name) => {
    expect(() => assertSafePackageName(name)).not.toThrow();
  });

  it.each([
    "../evil",
    "..",
    "foo/../bar",
    "/abs",
    "com.example/app",
    "com.example\\app",
    "com.example\0app",
    ".hidden",
    "no_dot",
    "",
    "1leading.digit",
    "com.example.",
  ])("rejects malformed package name %s", (name) => {
    expect(() => assertSafePackageName(name)).toThrow(IdentityError);
  });

  it("rejects non-string values", () => {
    expect(() => assertSafePackageName(null)).toThrow(IdentityError);
    expect(() => assertSafePackageName(undefined)).toThrow(IdentityError);
    expect(() => assertSafePackageName(42)).toThrow(IdentityError);
  });
});

describe("assertSafeRunId", () => {
  it("accepts a value freshly minted by mintRunId()", () => {
    const id = mintRunId(new Date("2026-05-19T10:15:49.821Z"));
    expect(() => assertSafeRunId(id)).not.toThrow();
  });

  it.each([
    "../2026-05-19T10-15-49.821Z_aB3k",
    "2026-05-19T10-15-49.821Z_aB3k/etc",
    "2026-05-19T10:15:49.821Z_aB3k", // unescaped colon
    "not-a-run-id",
    "",
  ])("rejects malformed runId %s", (id) => {
    expect(() => assertSafeRunId(id)).toThrow(IdentityError);
  });
});

describe("assertSafeDeviceSerial", () => {
  it.each([
    ["951a20a2"], // usb
    ["emulator-5554"],
    ["127.0.0.1:5555"], // adb TCP
    ["ZX1G226PMC"],
    ["device_with_underscore"],
  ])("accepts %s", (serial) => {
    expect(() => assertSafeDeviceSerial(serial)).not.toThrow();
  });

  it.each([
    "../foo",
    "/foo",
    "foo/bar",
    "foo\\bar",
    "foo\0bar",
    ".starts-with-dot",
    "",
    "has spaces",
    "weird*char",
  ])("rejects %s", (serial) => {
    expect(() => assertSafeDeviceSerial(serial)).toThrow(IdentityError);
  });
});

describe("assertSafeUserId", () => {
  it.each([[0], [10], [11], [99]])("accepts non-negative integer %i", (n) => {
    expect(() => assertSafeUserId(n)).not.toThrow();
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])("rejects %p", (n) => {
    expect(() => assertSafeUserId(n)).toThrow(IdentityError);
  });

  it("rejects non-number values", () => {
    expect(() => assertSafeUserId("0")).toThrow(IdentityError);
    expect(() => assertSafeUserId(null)).toThrow(IdentityError);
  });
});
