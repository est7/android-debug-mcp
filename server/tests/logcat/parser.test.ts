import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ParseResult, looksTruncated, parseThreadtimeLine } from "../../src/logcat/parser.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "logcat");

function parseFixture(name: string): ParseResult[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map(parseThreadtimeLine);
}

function countKinds(results: ParseResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  return counts;
}

describe("parseThreadtimeLine — uid-column format", () => {
  it("parses a -v uid -v threadtime line into a structured entry", () => {
    const r = parseThreadtimeLine(
      "05-20 10:15:49.820 10100  4567  4590 W MyApp   : slow query took 240ms",
    );
    expect(r.kind).toBe("entry");
    if (r.kind !== "entry") throw new Error("unreachable");
    expect(r.entry).toMatchObject({
      tsRaw: "05-20 10:15:49.820",
      uid: "10100",
      pid: 4567,
      tid: 4590,
      level: "W",
      tag: "MyApp",
      message: "slow query took 240ms",
    });
  });

  it("parses a threadtime line without a uid column (older devices)", () => {
    const r = parseThreadtimeLine("05-20 10:15:49.820  4567  4590 I ActivityManager: started");
    expect(r.kind).toBe("entry");
    if (r.kind !== "entry") throw new Error("unreachable");
    expect(r.entry.uid).toBeNull();
    expect(r.entry.pid).toBe(4567);
    expect(r.entry.tag).toBe("ActivityManager");
  });

  it("recognizes `--------- beginning of <buffer>` markers", () => {
    expect(parseThreadtimeLine("--------- beginning of crash")).toEqual({
      kind: "buffer_switch",
      buffer: "crash",
    });
  });

  it("classifies unprefixed indented / `at` / `Caused by:` lines as continuations", () => {
    expect(parseThreadtimeLine("\tat com.example.app.Repo.load(Repo.kt:42)").kind).toBe(
      "continuation",
    );
    expect(parseThreadtimeLine("Caused by: java.io.IOException: disk gone").kind).toBe(
      "continuation",
    );
    expect(parseThreadtimeLine("    ... 7 more").kind).toBe("continuation");
  });

  it("treats an empty line as blank and gibberish as unparsed", () => {
    expect(parseThreadtimeLine("").kind).toBe("blank");
    expect(parseThreadtimeLine("not a logcat line at all").kind).toBe("unparsed");
  });
});

describe("parseThreadtimeLine — fixture coverage", () => {
  it("normal.txt → 7 entries + 2 buffer switches", () => {
    const counts = countKinds(parseFixture("normal.txt"));
    expect(counts.entry).toBe(7);
    expect(counts.buffer_switch).toBe(2);
  });

  it("multiline-stack.txt → entries plus unprefixed continuations", () => {
    const counts = countKinds(parseFixture("multiline-stack.txt"));
    // 3 prefixed entries (risky thing / IllegalStateException / recovered),
    // 5 unprefixed continuation lines (3× at, Caused by, ... more).
    expect(counts.entry).toBe(3);
    expect(counts.continuation).toBe(5);
  });

  it("crash-java.txt lines all parse as entries (AndroidRuntime re-prefixes)", () => {
    const counts = countKinds(parseFixture("crash-java.txt"));
    expect(counts.entry).toBe(8);
    expect(counts.unparsed ?? 0).toBe(0);
  });

  it("unicode.txt — CJK / emoji / multi-script messages parse with content preserved", () => {
    const messages = parseFixture("unicode.txt")
      .map((r) => (r.kind === "entry" ? r.entry.message : ""))
      .filter((m) => m !== "");
    expect(messages.some((m) => m.includes("中文日志:用户点击了登录按钮"))).toBe(true);
    expect(messages.some((m) => m.includes("✅ 🚀"))).toBe(true);
    expect(messages.some((m) => m.includes("日本語テスト") && m.includes("한국어"))).toBe(true);
  });

  it("unicode.txt — a non-threadtime drift line is `unparsed`, never a crash", () => {
    const counts = countKinds(parseFixture("unicode.txt"));
    // 1 buffer switch, 5 well-formed entries, 1 garbage line.
    expect(counts.buffer_switch).toBe(1);
    expect(counts.entry).toBe(5);
    expect(counts.unparsed).toBe(1);
  });
});

describe("looksTruncated", () => {
  it("flags a long message whose tail looks cut mid-token", () => {
    expect(looksTruncated(`payload=${"A".repeat(4200)}`)).toBe(true);
  });

  it("does not flag a short message", () => {
    expect(looksTruncated("short and tidy.")).toBe(false);
  });

  it("does not flag a long message that ends naturally", () => {
    expect(looksTruncated(`${"word ".repeat(1000)}done.`)).toBe(false);
  });

  it("the truncated.txt fixture's long line is flagged", () => {
    const results = parseFixture("truncated.txt");
    const long = results.find((r) => r.kind === "entry" && r.entry.message.length > 4000);
    expect(long).toBeDefined();
    if (long?.kind === "entry") {
      expect(looksTruncated(long.entry.message)).toBe(true);
    }
  });
});
