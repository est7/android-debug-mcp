import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullFile, statMtimeMs } from "../../src/adb/evidence.ts";

// Mock the adb wrapper so these tests run hermetically — no real device.
const runAdbMock = vi.fn();
vi.mock("../../src/adb/adb.ts", () => ({
  runAdb: (...args: unknown[]) => runAdbMock(...args),
}));

beforeEach(() => {
  runAdbMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("statMtimeMs", () => {
  it("converts seconds-since-epoch stdout into ms", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "1716678000\n",
      stderr: "",
      exitCode: 0,
    });
    const got = await statMtimeMs("DEV0", "/sdcard/x.jsonl");
    expect(got).toBe(1716678000 * 1000);
  });

  it("passes -s, shell, stat -c %Y, and the device path to runAdb", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
    });
    await statMtimeMs("DEV0", "/path/with spaces.jsonl");
    expect(runAdbMock).toHaveBeenCalledTimes(1);
    expect(runAdbMock.mock.calls[0]?.[0]).toEqual([
      "-s",
      "DEV0",
      "shell",
      "stat",
      "-c",
      "%Y",
      "/path/with spaces.jsonl",
    ]);
  });

  it("returns null when stat exits non-zero with `No such file or directory`", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "",
      stderr: "stat: '/missing': No such file or directory\n",
      exitCode: 1,
    });
    expect(await statMtimeMs("DEV0", "/missing")).toBeNull();
  });

  it("returns null for BusyBox-style empty-stdout zero-exit", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await statMtimeMs("DEV0", "/whatever")).toBeNull();
  });

  it("throws on non-zero exit that does not look like a missing-file error", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "",
      stderr: "Permission denied\n",
      exitCode: 13,
    });
    await expect(statMtimeMs("DEV0", "/sdcard/x")).rejects.toThrow(/exited 13/);
  });

  it("throws when stat returns unparseable output", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "not-a-number\n",
      stderr: "",
      exitCode: 0,
    });
    await expect(statMtimeMs("DEV0", "/sdcard/x")).rejects.toThrow(/unparseable mtime/);
  });

  it("honors the timeoutMs override", async () => {
    runAdbMock.mockResolvedValueOnce({ args: [], stdout: "1\n", stderr: "", exitCode: 0 });
    await statMtimeMs("DEV0", "/x", { timeoutMs: 100 });
    expect(runAdbMock.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 100, allowNonZero: true });
  });
});

describe("pullFile", () => {
  it("invokes adb pull with -s, the device path, and the local path", async () => {
    runAdbMock.mockResolvedValueOnce({
      args: [],
      stdout: "1 file pulled.",
      stderr: "",
      exitCode: 0,
    });
    await pullFile("DEV0", "/sdcard/x.jsonl", "/tmp/evidence/x.jsonl");
    expect(runAdbMock).toHaveBeenCalledTimes(1);
    expect(runAdbMock.mock.calls[0]?.[0]).toEqual([
      "-s",
      "DEV0",
      "pull",
      "/sdcard/x.jsonl",
      "/tmp/evidence/x.jsonl",
    ]);
  });

  it("does NOT pass allowNonZero — pull failures must surface as AdbExecError", async () => {
    runAdbMock.mockResolvedValueOnce({ args: [], stdout: "", stderr: "", exitCode: 0 });
    await pullFile("DEV0", "/x", "/y");
    const opts = runAdbMock.mock.calls[0]?.[1] as { allowNonZero?: boolean };
    expect(opts.allowNonZero).toBeUndefined();
  });

  it("honors the timeoutMs override", async () => {
    runAdbMock.mockResolvedValueOnce({ args: [], stdout: "", stderr: "", exitCode: 0 });
    await pullFile("DEV0", "/x", "/y", { timeoutMs: 2_000 });
    expect(runAdbMock.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 2_000 });
  });

  it("propagates the underlying adb rejection (does not swallow)", async () => {
    runAdbMock.mockRejectedValueOnce(
      new Error("adb pull /x exited 1: remote object does not exist"),
    );
    await expect(pullFile("DEV0", "/x", "/y")).rejects.toThrow(/remote object does not exist/);
  });
});
