import { describe, expect, it } from "vitest";
import { detectDropout } from "../../src/logcat/dropout.ts";

describe("detectDropout", () => {
  it("detects chatty `identical N lines`", () => {
    expect(detectDropout("uid=10100(com.example.app) MyApp identical 47 lines")).toEqual({
      count: 47,
      reason: "chatty-identical",
    });
  });

  it("detects chatty `expire N lines`", () => {
    expect(detectDropout("uid=10100(com.example.app) MyApp expire 12 lines")).toEqual({
      count: 12,
      reason: "chatty-expire",
    });
  });

  it("detects an explicit `N lines dropped` marker", () => {
    expect(detectDropout("--- 318 lines dropped ---")).toEqual({
      count: 318,
      reason: "dropped",
    });
  });

  it("returns null for an ordinary message", () => {
    expect(detectDropout("user tapped the login button")).toBeNull();
    expect(detectDropout("loaded 5 items from cache")).toBeNull();
  });

  it("handles the singular `1 line`", () => {
    expect(detectDropout("MyApp expire 1 line")?.count).toBe(1);
  });
});
