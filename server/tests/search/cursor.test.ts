import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/search/cursor.ts";

describe("search cursor", () => {
  it("round-trips offset + scanned", () => {
    const decoded = decodeCursor(encodeCursor({ offset: 4096, scanned: 250 }));
    expect(decoded).toEqual({ offset: 4096, scanned: 250 });
  });

  it("produces an opaque base64 string with no JSON punctuation", () => {
    const cursor = encodeCursor({ offset: 1, scanned: 2 });
    expect(cursor).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it.each([
    ["not base64 of JSON", "not-a-cursor!!!"],
    ["base64 of non-JSON", Buffer.from("hello", "utf8").toString("base64")],
    ["missing fields", Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64")],
    [
      "negative offset",
      Buffer.from(JSON.stringify({ offset: -1, scanned: 0 }), "utf8").toString("base64"),
    ],
    [
      "non-integer offset",
      Buffer.from(JSON.stringify({ offset: 1.5, scanned: 0 }), "utf8").toString("base64"),
    ],
  ])("rejects %s with invalid_cursor", (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrowError(/invalid_cursor|valid search_logs cursor/);
  });
});
