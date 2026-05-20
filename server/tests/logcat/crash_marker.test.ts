import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectCrashSignature } from "../../src/logcat/crash_marker.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "logcat");

function crashHits(name: string) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .map(detectCrashSignature)
    .filter((s): s is NonNullable<typeof s> => s !== null);
}

describe("detectCrashSignature", () => {
  it("flags a Java FATAL EXCEPTION line", () => {
    const s = detectCrashSignature("05-20 10:17:10 E AndroidRuntime: FATAL EXCEPTION: main");
    expect(s).toEqual({ type: "java", marker: "FATAL EXCEPTION" });
  });

  it("flags an unprefixed `Caused by:` continuation", () => {
    expect(detectCrashSignature("Caused by: java.io.IOException: disk gone")?.type).toBe("java");
  });

  it("flags a native SIGSEGV signal line", () => {
    expect(detectCrashSignature("F libc: Fatal signal 11 (SIGSEGV), code 1")?.type).toBe("native");
  });

  it("flags the native tombstone `*** *** ***` banner", () => {
    expect(detectCrashSignature("F DEBUG: *** *** *** *** *** *** ***")?.type).toBe("native");
  });

  it("flags an `ANR in` line", () => {
    expect(detectCrashSignature("E ActivityManager: ANR in com.example.app")?.type).toBe("anr");
  });

  it("does NOT flag a bare `Reason:` line (too generic on its own)", () => {
    expect(
      detectCrashSignature("E ActivityManager: Reason: Input dispatching timed out"),
    ).toBeNull();
  });

  it("returns null for an ordinary line", () => {
    expect(detectCrashSignature("05-20 10:15 I MyApp: everything is fine")).toBeNull();
  });

  it("fixture coverage: each crash fixture yields at least one signature of the right type", () => {
    expect(crashHits("crash-java.txt").some((s) => s.type === "java")).toBe(true);
    expect(crashHits("crash-native.txt").some((s) => s.type === "native")).toBe(true);
    expect(crashHits("anr.txt").some((s) => s.type === "anr")).toBe(true);
    // The normal log has no crash signatures.
    expect(crashHits("normal.txt")).toHaveLength(0);
  });
});
