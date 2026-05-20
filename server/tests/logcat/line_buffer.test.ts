import { describe, expect, it } from "vitest";
import { LineBuffer, MAX_LINE_BUFFER_CHARS } from "../../src/logcat/line_buffer.ts";

describe("LineBuffer", () => {
  it("emits only complete lines, holding a partial line across pushes", () => {
    const lb = new LineBuffer();
    expect(lb.push("hello ").lines).toEqual([]);
    expect(lb.push("world\nsecond").lines).toEqual(["hello world"]);
    expect(lb.push(" line\n").lines).toEqual(["second line"]);
  });

  it("never splits a line on a chunk boundary", () => {
    const lb = new LineBuffer();
    const all: string[] = [];
    for (const ch of "alpha\nbeta\ngamma\n") {
      all.push(...lb.push(ch).lines);
    }
    expect(all).toEqual(["alpha", "beta", "gamma"]);
  });

  it("strips a trailing CR (CRLF input)", () => {
    const lb = new LineBuffer();
    expect(lb.push("windows\r\nline\r\n").lines).toEqual(["windows", "line"]);
  });

  it("flush() emits a final unterminated line", () => {
    const lb = new LineBuffer();
    lb.push("no newline here");
    expect(lb.flush()).toEqual(["no newline here"]);
    expect(lb.flush()).toEqual([]);
  });

  it("force-emits a newline-less run at the 64K cap and reports it abnormal", () => {
    const lb = new LineBuffer();
    const huge = "x".repeat(MAX_LINE_BUFFER_CHARS + 10);
    const result = lb.push(huge);
    expect(result.abnormalLongLines).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect((result.lines[0] as string).length).toBeGreaterThanOrEqual(MAX_LINE_BUFFER_CHARS);
    // Buffer was reset → a normal following line still works.
    expect(lb.push("normal\n").lines).toEqual(["normal"]);
  });

  it("a normal-length line never triggers the abnormal path", () => {
    const lb = new LineBuffer();
    const result = lb.push(`${"y".repeat(2000)}\n`);
    expect(result.abnormalLongLines).toBe(0);
    expect(result.lines).toHaveLength(1);
  });
});
