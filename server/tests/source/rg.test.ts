import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RgNotFoundError, SearchTimedOutError } from "../../src/source/errors.ts";
import { getRgPath, parseRgJsonMatches, resetRgPathCache, runRg } from "../../src/source/rg.ts";

const savedRgPath = process.env.RG_PATH;
let scratch = "";

beforeEach(() => {
  resetRgPathCache();
  scratch = mkdtempSync(join(tmpdir(), "android-debug-mcp-rg-"));
});

afterEach(() => {
  if (savedRgPath === undefined) {
    // biome-ignore lint/performance/noDelete: env unset, not the string "undefined".
    delete process.env.RG_PATH;
  } else {
    process.env.RG_PATH = savedRgPath;
  }
  resetRgPathCache();
  rmSync(scratch, { recursive: true, force: true });
});

describe("getRgPath — binary resolution (modeled on getAdbPath)", () => {
  it("resolves rg from PATH when RG_PATH is unset", async () => {
    // biome-ignore lint/performance/noDelete: explicit absence of the override.
    delete process.env.RG_PATH;
    const path = await getRgPath();
    expect(path.endsWith("rg")).toBe(true);
  });

  it("honors an executable RG_PATH override verbatim", async () => {
    // getRgPath only checks executability — point it at a known-good binary.
    process.env.RG_PATH = process.execPath;
    expect(await getRgPath()).toBe(process.execPath);
  });

  it("throws RgNotFoundError when RG_PATH points at a non-existent binary", async () => {
    process.env.RG_PATH = join(scratch, "no-such-rg");
    await expect(getRgPath()).rejects.toBeInstanceOf(RgNotFoundError);
  });
});

describe("runRg — exit-code contract", () => {
  it("returns exitCode 0 with a JSON stream when matches are found", async () => {
    writeFileSync(join(scratch, "Sample.kt"), "val token = loginButton\n");
    const result = await runRg(["--json", "-e", "loginButton", "-g", "*.kt", "."], {
      cwd: scratch,
    });
    expect(result.exitCode).toBe(0);
    expect(parseRgJsonMatches(result.stdout)).toHaveLength(1);
  });

  it("returns exitCode 1 (no matches) as a normal result, not an error", async () => {
    writeFileSync(join(scratch, "Sample.kt"), "val token = somethingElse\n");
    const result = await runRg(["--json", "-e", "loginButton", "-g", "*.kt", "."], {
      cwd: scratch,
    });
    expect(result.exitCode).toBe(1);
    expect(parseRgJsonMatches(result.stdout)).toHaveLength(0);
  });

  it("throws SearchTimedOutError when the search exceeds its budget", async () => {
    writeFileSync(join(scratch, "Sample.kt"), "val token = loginButton\n");
    // A 1ms ceiling is below process-spawn latency — the child is always killed.
    await expect(
      runRg(["--json", "-e", "loginButton", "."], { cwd: scratch, timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(SearchTimedOutError);
  });
});

describe("parseRgJsonMatches", () => {
  it("extracts match records and skips begin/end/summary framing", () => {
    const stream = [
      '{"type":"begin","data":{"path":{"text":"app/Foo.kt"}}}',
      '{"type":"match","data":{"path":{"text":"app/Foo.kt"},"lines":{"text":"  binding.loginButton.x()\\n"},"line_number":12}}',
      '{"type":"end","data":{"path":{"text":"app/Foo.kt"}}}',
      '{"type":"summary","data":{"elapsed_total":{"human":"0.01s"}}}',
    ].join("\n");
    const matches = parseRgJsonMatches(stream);
    expect(matches).toEqual([{ file: "app/Foo.kt", line: 12, text: "  binding.loginButton.x()" }]);
  });

  it("strips a leading ./ from the reported path and skips non-JSON lines", () => {
    const stream = [
      "not json at all",
      '{"type":"match","data":{"path":{"text":"./app/Bar.kt"},"lines":{"text":"row\\n"},"line_number":3}}',
    ].join("\n");
    expect(parseRgJsonMatches(stream)).toEqual([{ file: "app/Bar.kt", line: 3, text: "row" }]);
  });

  it("returns an empty array for an empty stream", () => {
    expect(parseRgJsonMatches("")).toEqual([]);
  });
});
