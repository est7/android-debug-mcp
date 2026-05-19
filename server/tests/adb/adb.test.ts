import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdbPath, resetAdbPathCache } from "../../src/adb/adb.ts";
import { AdbNotFoundError } from "../../src/adb/errors.ts";

const savedEnv = process.env.ADB_PATH;

describe("getAdbPath ADB_PATH override", () => {
  beforeEach(() => {
    resetAdbPathCache();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      // biome-ignore lint/performance/noDelete: must actually remove the env var; setting it to undefined sets the literal string "undefined".
      delete process.env.ADB_PATH;
    } else {
      process.env.ADB_PATH = savedEnv;
    }
    resetAdbPathCache();
  });

  it("throws AdbNotFoundError when ADB_PATH points at a non-existent file", async () => {
    process.env.ADB_PATH = "/definitely/not/a/real/adb-binary";
    await expect(getAdbPath()).rejects.toBeInstanceOf(AdbNotFoundError);
  });

  it("throws AdbNotFoundError when ADB_PATH points at a non-executable file", async () => {
    // package.json is guaranteed to exist in the repo and not be marked executable.
    process.env.ADB_PATH = `${process.cwd()}/package.json`;
    await expect(getAdbPath()).rejects.toBeInstanceOf(AdbNotFoundError);
  });

  it("error message mentions the ADB_PATH the user set, not just 'which adb'", async () => {
    process.env.ADB_PATH = "/no/such/path/adb-bogus";
    await expect(getAdbPath()).rejects.toThrow(/ADB_PATH=\/no\/such\/path\/adb-bogus/);
  });
});
