import { afterEach, describe, expect, it, vi } from "vitest";
import { runAdb } from "../../src/adb/adb.ts";
import { probeViewport } from "../../src/adb/viewport.ts";

/**
 * v2-F.3 Round 3 advisory follow-up: `probeViewport` parser had only
 * boundary-mocked integration coverage via the MCP tests. This file
 * exercises the regex precedence (Override > Physical) and the three
 * failure paths (non-zero exit, regex no-match, runAdb throws) directly.
 */

vi.mock("../../src/adb/adb.ts", () => ({ runAdb: vi.fn() }));

const STDOUT_PHYSICAL_ONLY = "Physical size: 1080x2400\n";
const STDOUT_OVERRIDE_AND_PHYSICAL = "Physical size: 1080x2400\nOverride size: 1440x3120\n";
const STDOUT_OVERRIDE_ONLY = "Override size: 1440x3120\n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeViewport — happy paths", () => {
  it("Physical size only → parses physical resolution", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: STDOUT_PHYSICAL_ONLY,
      stderr: "",
      exitCode: 0,
    });
    expect(await probeViewport("DEV0")).toEqual({ w: 1080, h: 2400 });
  });

  it("Override + Physical → Override wins (preferred)", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: STDOUT_OVERRIDE_AND_PHYSICAL,
      stderr: "",
      exitCode: 0,
    });
    expect(await probeViewport("DEV0")).toEqual({ w: 1440, h: 3120 });
  });

  it("Override only → parses override resolution", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: STDOUT_OVERRIDE_ONLY,
      stderr: "",
      exitCode: 0,
    });
    expect(await probeViewport("DEV0")).toEqual({ w: 1440, h: 3120 });
  });
});

describe("probeViewport — failure paths return null (fail-soft, never throw)", () => {
  it("non-zero exit code → null", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    expect(await probeViewport("DEV0")).toBeNull();
  });

  it("stdout in unexpected format → null", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: "ROM-specific format with no size lines\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await probeViewport("DEV0")).toBeNull();
  });

  it("runAdb throws (e.g. AdbNotFoundError) → null", async () => {
    vi.mocked(runAdb).mockRejectedValue(new Error("adb not found"));
    expect(await probeViewport("DEV0")).toBeNull();
  });

  it("zero / negative dimensions → null (defensive)", async () => {
    vi.mocked(runAdb).mockResolvedValue({
      args: [],
      stdout: "Physical size: 0x2400\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await probeViewport("DEV0")).toBeNull();
  });
});
