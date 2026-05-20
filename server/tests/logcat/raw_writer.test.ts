import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RawWriter } from "../../src/logcat/raw_writer.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-raw-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("RawWriter", () => {
  it("writes bytes through verbatim, byte-for-byte", async () => {
    const path = join(scratch, "logcat.raw.txt");
    const w = await RawWriter.open(path);
    const enc = new TextEncoder();
    w.write(enc.encode("line one\n"));
    w.write(enc.encode("line two\n"));
    await w.close();
    expect(readFileSync(path, "utf8")).toBe("line one\nline two\n");
  });

  it("preserves arbitrary (non-utf8-aligned) bytes unchanged", async () => {
    const path = join(scratch, "raw-bytes.txt");
    const w = await RawWriter.open(path);
    // A chunk split mid-multibyte-sequence must NOT be corrupted — the raw
    // writer never decodes, so the two halves rejoin exactly.
    const full = new TextEncoder().encode("héllo ☃\n");
    w.write(full.slice(0, 3));
    w.write(full.slice(3));
    await w.close();
    expect(new Uint8Array(readFileSync(path))).toEqual(full);
  });

  it("tracks total bytes written", async () => {
    const path = join(scratch, "count.txt");
    const w = await RawWriter.open(path);
    w.write(new TextEncoder().encode("12345\n"));
    await w.flush();
    expect(w.bytesWritten).toBe(6);
    await w.close();
  });

  it("flush is durable and close is idempotent", async () => {
    const path = join(scratch, "idem.txt");
    const w = await RawWriter.open(path);
    w.write(new TextEncoder().encode("data\n"));
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("data\n");
  });

  it("rejects writes after close", async () => {
    const w = await RawWriter.open(join(scratch, "closed.txt"));
    await w.close();
    expect(() => w.write(new TextEncoder().encode("x"))).toThrow();
  });
});
