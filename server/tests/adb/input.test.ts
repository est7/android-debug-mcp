import { describe, expect, it } from "vitest";
import { encodeInputB64 } from "../../src/adb/input.ts";

describe("encodeInputB64", () => {
  // The base64 alphabet is A-Za-z0-9+/= — no space, no shell metacharacter — so
  // the encoded form is the same safe shape for every input class. These cases
  // lock that property: ASCII, CJK, emoji, shell metacharacters, quotes and
  // newlines all encode without exception and decode back byte-identical. This
  // is the whole reason `input_text` needs no ASCII/Unicode branching.
  it.each([
    ["ascii with spaces", "hello world"],
    ["cjk", "中文测试"],
    ["emoji", "tap 👍 then 🚀"],
    ["shell metacharacters", "rm -rf /; echo $PATH `id` & (x)"],
    ["single and double quotes", `a'b"c`],
    ["newline and tab", "line1\nline2\tend"],
    ["single char", "x"],
  ])("round-trips %s through base64", (_label, text) => {
    const encoded = encodeInputB64(text);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
  });

  it("encodes a known vector exactly", () => {
    expect(encodeInputB64("search query")).toBe("c2VhcmNoIHF1ZXJ5");
  });

  it("output is free of spaces and shell metacharacters", () => {
    const encoded = encodeInputB64('the quick (brown) fox; $HOME & "jumps"');
    expect(encoded).not.toMatch(/[\s;&$`(){}[\]'"*?|<>]/);
  });
});
