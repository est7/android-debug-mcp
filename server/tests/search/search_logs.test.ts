import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LogEntry, searchLogs } from "../../src/search/search_logs.ts";

const BUDGET = 23_000;

const ENTRIES: LogEntry[] = [
  {
    tsRaw: "05-20 10:00:01.000",
    rawLineNo: 1,
    buffer: "main",
    level: "I",
    tag: "App",
    pid: 100,
    tid: 100,
    message: "application started",
  },
  {
    tsRaw: "05-20 10:00:02.000",
    rawLineNo: 2,
    buffer: "main",
    level: "D",
    tag: "Net",
    pid: 100,
    tid: 101,
    message: "GET /api/users",
  },
  {
    tsRaw: "05-20 10:00:03.000",
    rawLineNo: 3,
    buffer: "main",
    level: "W",
    tag: "Cache",
    pid: 100,
    tid: 100,
    message: "cache miss for key alpha",
  },
  {
    tsRaw: "05-20 10:00:04.000",
    rawLineNo: 4,
    buffer: "system",
    level: "E",
    tag: "ActivityManager",
    pid: 9,
    tid: 9,
    message: "window leaked by Activity",
  },
  {
    tsRaw: "05-20 10:00:05.000",
    rawLineNo: 5,
    buffer: "main",
    level: "E",
    tag: "App",
    pid: 100,
    tid: 100,
    message: "NullPointer while rendering CACHE view",
  },
  {
    tsRaw: "05-20 10:00:06.000",
    rawLineNo: 6,
    buffer: "crash",
    level: "F",
    tag: "libc",
    pid: 100,
    tid: 100,
    message: "Fatal signal 11 (SIGSEGV)",
  },
  {
    tsRaw: "05-20 10:00:07.000",
    rawLineNo: 7,
    buffer: "main",
    level: "I",
    tag: "App",
    pid: 100,
    tid: 100,
    message: "recovered after crash",
  },
  {
    tsRaw: "05-20 10:00:08.000",
    rawLineNo: 8,
    buffer: "main",
    level: "V",
    tag: "Trace",
    pid: 100,
    tid: 102,
    message: "verbose trace tick",
  },
];

let runDir = "";

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "adm-search-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

/** Write logcat.jsonl; return the byte offset of each line's start. */
function writeLogcat(entries: LogEntry[]): number[] {
  const offsets: number[] = [];
  let body = "";
  let off = 0;
  for (const e of entries) {
    offsets.push(off);
    const line = `${JSON.stringify(e)}\n`;
    body += line;
    off += Buffer.byteLength(line, "utf8");
  }
  writeFileSync(join(runDir, "logcat.jsonl"), body);
  return offsets;
}

function writeMark(name: string, logcatOffset: number | null): void {
  writeFileSync(
    join(runDir, "events.jsonl"),
    `${JSON.stringify({ type: "mark", name, ts: "2026-05-20T10:00:00.000Z", logcatOffset })}\n`,
  );
}

describe("searchLogs filters", () => {
  it("returns every entry with no filter", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100 }, BUDGET);
    expect(r.entries).toHaveLength(ENTRIES.length);
    expect(r.matched).toBe(ENTRIES.length);
    expect(r.scanned).toBe(ENTRIES.length);
    expect(r.nextCursor).toBeUndefined();
  });

  it("matches `query` as a case-insensitive substring of the message", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, query: "cache" }, BUDGET);
    // "cache miss for key alpha" and "...rendering CACHE view"
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([3, 5]);
  });

  it("treats `level` as a severity threshold (W returns W/E/F)", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, level: "W" }, BUDGET);
    expect(r.entries.map((e) => e.level)).toEqual(["W", "E", "E", "F"]);
  });

  it("filters by exact buffer", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, buffer: "system" }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([4]);
  });

  it("filters by `sinceTs` lexically against the device clock", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, sinceTs: "05-20 10:00:06.000" }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([6, 7, 8]);
  });

  it("keeps only entries whose tag is in `tags` (single)", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, tags: ["App"] }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([1, 5, 7]);
  });

  it("keeps entries matching any tag in `tags` (multiple)", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, tags: ["Net", "Cache"] }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([2, 3]);
  });

  it("drops entries whose tag is in `excludeTags`", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, excludeTags: ["App"] }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([2, 3, 4, 6, 8]);
  });

  it("applies `excludeTags` after `tags` — exclude wins on overlap", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(
      runDir,
      { limit: 100, tags: ["App", "Net"], excludeTags: ["App"] },
      BUDGET,
    );
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([2]);
  });

  it("matches tags case-sensitively (no case folding like `query`)", async () => {
    writeLogcat(ENTRIES);
    const r = await searchLogs(runDir, { limit: 100, tags: ["app"] }, BUDGET);
    expect(r.entries).toEqual([]);
    expect(r.matched).toBe(0);
  });

  it("yields no entries (and no error) when logcat.jsonl is absent", async () => {
    const r = await searchLogs(runDir, { limit: 100 }, BUDGET);
    expect(r.entries).toEqual([]);
    expect(r.matched).toBe(0);
  });
});

describe("searchLogs pagination", () => {
  it("caps a page at `limit` and resumes exactly via nextCursor", async () => {
    writeLogcat(ENTRIES);
    const collected: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await searchLogs(runDir, { limit: 3, ...(cursor ? { cursor } : {}) }, BUDGET);
      collected.push(...r.entries.map((e) => e.rawLineNo));
      cursor = r.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);
    // every entry, once, in order — no gaps, no dupes.
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("re-applies a `tags` filter identically across paginated pages", async () => {
    writeLogcat(ENTRIES);
    const collected: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await searchLogs(
        runDir,
        { limit: 2, tags: ["App"], ...(cursor ? { cursor } : {}) },
        BUDGET,
      );
      collected.push(...r.entries.map((e) => e.rawLineNo));
      cursor = r.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);
    // App lines only, once each, in order — filter stable across resume.
    expect(collected).toEqual([1, 5, 7]);
  });

  it("rejects a malformed cursor with invalid_cursor", async () => {
    writeLogcat(ENTRIES);
    await expect(searchLogs(runDir, { limit: 10, cursor: "garbage" }, BUDGET)).rejects.toThrow(
      /valid search_logs cursor/,
    );
  });
});

describe("searchLogs mark windows", () => {
  it("afterMark keeps entries at/after the mark's logcat offset", async () => {
    const offsets = writeLogcat(ENTRIES);
    writeMark("midpoint", offsets[4] ?? 0); // entry rawLineNo 5
    const r = await searchLogs(runDir, { limit: 100, afterMark: "midpoint" }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([5, 6, 7, 8]);
  });

  it("beforeMark keeps entries before the mark's logcat offset", async () => {
    const offsets = writeLogcat(ENTRIES);
    writeMark("midpoint", offsets[4] ?? 0);
    const r = await searchLogs(runDir, { limit: 100, beforeMark: "midpoint" }, BUDGET);
    expect(r.entries.map((e) => e.rawLineNo)).toEqual([1, 2, 3, 4]);
  });

  it("throws mark_not_found for an unknown mark name", async () => {
    writeLogcat(ENTRIES);
    writeMark("midpoint", 0);
    await expect(searchLogs(runDir, { limit: 100, afterMark: "nope" }, BUDGET)).rejects.toThrow(
      /No mark named/,
    );
  });
});

describe("searchLogs response budget (§ G-5)", () => {
  it("cuts the message of a single line that alone exceeds the budget", async () => {
    const huge: LogEntry = {
      tsRaw: "05-20 10:00:09.000",
      rawLineNo: 9,
      buffer: "main",
      level: "E",
      tag: "Big",
      pid: 100,
      tid: 100,
      message: "X".repeat(50_000),
    };
    writeLogcat([huge]);
    const r = await searchLogs(runDir, { limit: 100 }, 5_000);
    expect(r.entries).toHaveLength(1);
    expect(r.truncated).toBe(true);
    expect(r.entries[0]?.message.length).toBeLessThan(50_000);
    expect(r.entries[0]?.message).toContain("message cut");
  });

  it("ends a page early (with a cursor) before an entry would overflow the budget", async () => {
    writeLogcat(ENTRIES);
    // A budget that fits ~2 entries forces an early page break.
    const r = await searchLogs(runDir, { limit: 100 }, 260);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.length).toBeLessThan(ENTRIES.length);
    expect(r.nextCursor).toBeDefined();
  });
});
