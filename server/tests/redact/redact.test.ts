import { describe, expect, it } from "vitest";
import {
  MAX_REDACT_DEPTH,
  REDACTED,
  isSensitiveKey,
  redactInputText,
  redactString,
  redactValue,
} from "../../src/redact/redact.ts";

describe("isSensitiveKey — layer 1 (object keys)", () => {
  it.each([
    "password",
    "Password",
    "userPassword",
    "user_password",
    "Authorization",
    "x-auth-token",
    "access_token",
    "refreshToken",
    "Cookie",
    "set-cookie",
    "otp",
    "otpCode",
    "verification",
    "verificationCode",
  ])("flags %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["username", "email", "deviceSerial", "runId", "status", "count"])(
    "leaves %s untouched",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redactString — layer 2 (embedded credentials)", () => {
  it.each<[string, string, string]>([
    ["bare key=value", "token=abc123", "token=***"],
    ["prefixed key", "access_token=secret", "access_token=***"],
    ["unquoted single-token password", "password=p4ssw0rd", "password=***"],
    ["otp kv", "otp=123456", "otp=***"],
    ["verification kv", "verification=999000", "verification=***"],
    ["uppercase term", "TOKEN=ABCDEF", "TOKEN=***"],
    ["url query single", "https://x.com/cb?token=abc", "https://x.com/cb?token=***"],
    [
      "url query multi",
      "https://x.com?token=aaa&otp=bbb&user=bob",
      "https://x.com?token=***&otp=***&user=bob",
    ],
    ["json-string single word", '{"password":"secret"}', '{"password":"***"}'],
    [
      "quoted multi-word password (P5-P1-2)",
      '{"password":"correct horse battery staple","user":"alice"}',
      '{"password":"***","user":"alice"}',
    ],
    ["quoted multi-word password, colon sep", 'password: "multi word secret"', 'password: "***"'],
    ["quoted multi-word verification", 'verification="123 456"', 'verification="***"'],
    ["quoted token swallows Bearer prefix", 'token="Bearer abc def"', 'token="***"'],
    ["authorization bearer", "Authorization: Bearer eyJabc.def.ghi", "Authorization: ***"],
    ["authorization basic", "Authorization: Basic dXNlcjpwYXNz", "Authorization: ***"],
    [
      "authorization digest — whole value redacted (P5-P1-1)",
      'Authorization: Digest username="alice", realm="api", response="secret"',
      "Authorization: ***",
    ],
    [
      "cookie — whole multi-cookie value redacted (P5-P1-1)",
      "Cookie: sid=xyz; session=s3cret; theme=dark",
      "Cookie: ***",
    ],
    [
      "set-cookie — whole response cookie value redacted",
      "Set-Cookie: sid=xyz; Path=/; HttpOnly",
      "Set-Cookie: ***",
    ],
    [
      "poppo URL stable identifiers",
      "GET /homepage?_sign=SIG&_uid=37142512&smei_id=device-a&uuid=9906b0cc&ok=1",
      "GET /homepage?_sign=***&_uid=***&smei_id=***&uuid=***&ok=1",
    ],
    [
      "poppo stable identifiers accept colon separators",
      '"smei_id":"9906b772cd3b27a0", device_id: 12345, uid: 37142512',
      '"smei_id":"***", device_id: ***, uid: ***',
    ],
    [
      "poppo uid key does not match inside longer words",
      "liquid=5 squid=6 uid=7",
      "liquid=5 squid=6 uid=***",
    ],
    ["unquoted token keeps Bearer prefix", "token: Bearer abc.def", "token: Bearer ***"],
    ["clean text untouched", "the quick brown fox jumps", "the quick brown fox jumps"],
    ["tokenizer is not a kv pair", "the tokenizer settings page", "the tokenizer settings page"],
    ["benign equals untouched", "count=5 and total=10", "count=5 and total=10"],
  ])("%s", (_label, input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it("blanks a bare JWT (three base64url segments)", () => {
    const jwt = "eyJhbGciOiJIUzI1Ni19.eyJzdWIiOiIxMjM0NTY3ODki.SflKxwRJSMeKKF2QT4";
    expect(redactString(`session ${jwt} ok`)).toBe(`session ${REDACTED} ok`);
  });

  it("is idempotent — re-running on redacted output is a no-op", () => {
    const once = redactString("token=abc&otp=xyz");
    expect(redactString(once)).toBe(once);
  });
});

describe("redactInputText — layer 3 (input_text heuristic)", () => {
  it.each([
    "my password is hunter2",
    "here is the login token",
    "the otp arrived",
    "enter the verification code",
    "PASSWORD",
  ])("redacts text mentioning a sensitive word: %s", (text) => {
    const r = redactInputText(text);
    expect(r.redacted).toBe(true);
    expect(r.value).toBe(`${REDACTED}${text.length}`);
  });

  it.each(["hello world", "search query for cats", "", "tap the blue button"])(
    "leaves ordinary text unchanged: %s",
    (text) => {
      const r = redactInputText(text);
      expect(r.redacted).toBe(false);
      expect(r.value).toBe(text);
    },
  );

  it("the placeholder encodes the original length", () => {
    expect(redactInputText("my token value here").value).toBe(`${REDACTED}19`);
  });
});

describe("redactValue — recursive (layers 1 + 2)", () => {
  it("blanks a sensitive top-level key", () => {
    expect(redactValue({ password: "hunter2", user: "alice" })).toEqual({
      password: REDACTED,
      user: "alice",
    });
  });

  it("scans non-sensitive string values for embedded credentials", () => {
    expect(redactValue({ note: "callback url is /cb?token=abc123" })).toEqual({
      note: "callback url is /cb?token=***",
    });
  });

  it("redacts sensitive keys nested in objects and arrays", () => {
    expect(redactValue({ headers: [{ Authorization: "Bearer xyz" }, { host: "x" }] })).toEqual({
      headers: [{ Authorization: REDACTED }, { host: "x" }],
    });
  });

  it("passes scalars through (numbers / booleans / null)", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
  });

  it("does not mutate the input object", () => {
    const input = { note: "token=abc" };
    redactValue(input);
    expect(input.note).toBe("token=abc");
  });

  it("replaces subtrees past MAX_REDACT_DEPTH with a marker", () => {
    let deep: Record<string, unknown> = { token: "leaf" };
    for (let i = 0; i < MAX_REDACT_DEPTH + 3; i++) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("redact:max-depth");
  });
});
