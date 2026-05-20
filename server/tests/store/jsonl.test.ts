import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppendStream,
  JsonlClosedError,
  JsonlEncodeError,
  JsonlInvalidRecordError,
  JsonlLineTooLargeError,
  MAX_LINE_BYTES,
} from "../../src/store/jsonl.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-jsonl-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("AppendStream", () => {
  it("appends each record as one JSON line terminated by \\n", async () => {
    const path = join(scratch, "events.jsonl");
    const stream = await AppendStream.open(path);
    await stream.append({ a: 1 });
    await stream.append({ b: "two", c: [3, 4] });
    await stream.close();
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ a: 1 });
    expect(JSON.parse(lines[1] as string)).toEqual({ b: "two", c: [3, 4] });
  });

  it("survives concurrent appends without torn lines", async () => {
    const path = join(scratch, "concurrent.jsonl");
    const stream = await AppendStream.open(path);
    const N = 200;
    const records = Array.from({ length: N }, (_, i) => ({ i, payload: "x".repeat(64) }));
    await Promise.all(records.map((r) => stream.append(r)));
    await stream.close();
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(N);
    const parsed = lines.map((l) => JSON.parse(l) as { i: number; payload: string });
    expect(new Set(parsed.map((p) => p.i)).size).toBe(N);
    for (const p of parsed) expect(p.payload).toBe("x".repeat(64));
  });

  it("flush() is idempotent and does not corrupt the file", async () => {
    const path = join(scratch, "flush.jsonl");
    const stream = await AppendStream.open(path);
    await stream.append({ x: 1 });
    await stream.flush();
    await stream.flush();
    await stream.append({ y: 2 });
    await stream.close();
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("throws JsonlClosedError when writing after close", async () => {
    const stream = await AppendStream.open(join(scratch, "closed.jsonl"));
    await stream.close();
    await expect(stream.append({ z: 1 })).rejects.toBeInstanceOf(JsonlClosedError);
    await expect(stream.flush()).rejects.toBeInstanceOf(JsonlClosedError);
  });

  it("throws JsonlEncodeError on circular payloads (no partial line written)", async () => {
    const path = join(scratch, "circular.jsonl");
    const stream = await AppendStream.open(path);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    await expect(stream.append(cyc)).rejects.toBeInstanceOf(JsonlEncodeError);
    await stream.close();
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("close() is idempotent", async () => {
    const stream = await AppendStream.open(join(scratch, "double-close.jsonl"));
    await stream.close();
    await expect(stream.close()).resolves.toBeUndefined();
  });

  it("rejects lines that exceed MAX_LINE_BYTES with JsonlLineTooLargeError (no partial write)", async () => {
    const path = join(scratch, "toobig.jsonl");
    const stream = await AppendStream.open(path);
    // JSON.stringify of {"msg": "x".repeat(N)} adds 10 wrapper bytes; sizing N
    // past MAX_LINE_BYTES guarantees the encoded line is over the cap.
    const huge = { msg: "x".repeat(MAX_LINE_BYTES + 100) };
    await expect(stream.append(huge)).rejects.toBeInstanceOf(JsonlLineTooLargeError);
    // Followup small append still works → no torn state.
    await stream.append({ ok: 1 });
    await stream.close();
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ ok: 1 });
  });

  it("MAX_LINE_BYTES is exposed for upstream sizing checks", () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024);
  });

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["function", () => 1],
    ["symbol", Symbol("nope")],
  ])(
    "rejects top-level %s records with JsonlInvalidRecordError (no JSONL poison)",
    async (label, value) => {
      const path = join(scratch, `invalid-${label}.jsonl`);
      const stream = await AppendStream.open(path);
      await expect(stream.append(value)).rejects.toBeInstanceOf(JsonlInvalidRecordError);
      // Followup valid append must succeed → state is not torn.
      await stream.append({ ok: 1, kind: label });
      await stream.close();
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l !== "");
      // The poisoned line was rejected → exactly one line on disk, and it parses
      // back to the followup record (no literal "undefined" sneaks in as a line).
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toEqual({ ok: 1, kind: label });
    },
  );

  it("does not leak the literal string 'undefined' into the JSONL even when the followup line is JSON", async () => {
    // Direct repro of codex' round-2 finding: append(undefined) must not write
    // anything observable; specifically, no unwrapped `undefined\n` line.
    const path = join(scratch, "undef-poison.jsonl");
    const stream = await AppendStream.open(path);
    await expect(stream.append(undefined)).rejects.toBeInstanceOf(JsonlInvalidRecordError);
    await stream.close();
    expect(readFileSync(path, "utf8")).toBe("");
  });
});
