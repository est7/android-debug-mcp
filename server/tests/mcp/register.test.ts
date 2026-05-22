import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdbExecError, AdbNotFoundError } from "../../src/adb/errors.ts";
import { ANDROID_DEBUG_TOOL_NAMES } from "../../src/mcp/constants.ts";
import {
  type DebugToolAnnotations,
  type DebugToolConfig,
  ToolRegistrationError,
  registerDebugTool,
  wrapToolHandler,
} from "../../src/mcp/register.ts";
import { ToolDomainError } from "../../src/mcp/toolError.ts";
import { ProjectRootMissingError, RgNotFoundError } from "../../src/source/errors.ts";

function freshServer(): McpServer {
  return new McpServer({ name: "android-debug-mcp-test", version: "0.0.0-test" });
}

const validAnnotations: DebugToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const validDescription = [
  "Lists adb devices.",
  "Use when: agent needs to pick a deviceSerial.",
  "Args: none.",
  "Returns: an array of devices.",
  "Errors: adb_not_found when adb binary missing.",
].join("\n");

const validInput = z.object({}).strict();
const validOutput = z.object({ devices: z.array(z.string()) }).strict();

function baseConfig(): DebugToolConfig<typeof validInput, typeof validOutput> {
  return {
    title: "list adb devices",
    description: validDescription,
    inputSchema: validInput,
    outputSchema: validOutput,
    annotations: validAnnotations,
  };
}

describe("registerDebugTool", () => {
  it("registers a tool that satisfies all contracts", () => {
    const server = freshServer();
    expect(() =>
      registerDebugTool(server, "android_debug_list_devices", baseConfig(), async () => ({
        structuredContent: { devices: ["abc"] },
      })),
    ).not.toThrow();
  });

  it("rejects names without android_debug_ prefix", () => {
    const server = freshServer();
    expect(() =>
      registerDebugTool(server, "list_devices", baseConfig(), async () => ({
        structuredContent: { devices: [] },
      })),
    ).toThrow(ToolRegistrationError);
  });

  it("rejects names that are not in the v1 inventory", () => {
    const server = freshServer();
    expect(() =>
      registerDebugTool(server, "android_debug_bogus_tool", baseConfig(), async () => ({
        structuredContent: { devices: [] },
      })),
    ).toThrow(/not in the v1 inventory/);
  });

  it("rejects descriptions missing required marker sections", () => {
    const server = freshServer();
    const cfg = { ...baseConfig(), description: "missing markers entirely" };
    expect(() =>
      registerDebugTool(server, "android_debug_list_devices", cfg, async () => ({
        structuredContent: { devices: [] },
      })),
    ).toThrow(/Use when:.*Args:.*Returns:.*Errors:/);
  });

  it("rejects input schemas that are not strict ZodObjects", () => {
    const server = freshServer();
    const loose = z.object({});
    const cfg = { ...baseConfig(), inputSchema: loose };
    expect(() =>
      registerDebugTool(server, "android_debug_list_devices", cfg, async () => ({
        structuredContent: { devices: [] },
      })),
    ).toThrow(/strict/);
  });

  it("rejects non-object outputSchema (MCP structuredContent contract)", () => {
    const server = freshServer();
    const cfg = { ...baseConfig(), outputSchema: z.array(z.string()) };
    expect(() =>
      registerDebugTool(server, "android_debug_list_devices", cfg, async () => ({
        structuredContent: [] as string[],
      })),
    ).toThrow(/outputSchema must be a ZodObject/);
  });

  it("rejects annotations missing any of the four hints", () => {
    const server = freshServer();
    const partial = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    const cfg = {
      ...baseConfig(),
      annotations: partial as unknown as DebugToolAnnotations,
    };
    expect(() =>
      registerDebugTool(server, "android_debug_list_devices", cfg, async () => ({
        structuredContent: { devices: [] },
      })),
    ).toThrow(/openWorldHint/);
  });

  it("keeps the canonical inventory in sync with the prefix rule", () => {
    for (const name of ANDROID_DEBUG_TOOL_NAMES) {
      expect(name.startsWith("android_debug_")).toBe(true);
    }
    // 19 tools — v1's 17 (§ G-Final) plus v2-A `tap_node` + `map_ui_node_to_source`.
    expect(ANDROID_DEBUG_TOOL_NAMES).toHaveLength(19);
    expect(new Set(ANDROID_DEBUG_TOOL_NAMES).size).toBe(ANDROID_DEBUG_TOOL_NAMES.length);
  });
});

describe("wrapToolHandler — result/error transport (open decision #13)", () => {
  it("success → content + structuredContent, no isError", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => ({
      structuredContent: { devices: ["abc"] },
    }));
    const result = await wrapped({});
    expect(result.structuredContent).toEqual({ devices: ["abc"] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ devices: ["abc"] });
  });

  it("ToolDomainError → isError:true, structured payload in content, no structuredContent", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new ToolDomainError("no_active_session", "nothing running", { runId: "r1" });
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      error: "no_active_session",
      message: "nothing running",
      runId: "r1",
    });
  });

  it("AdbError → isError:true, {error:code,message} envelope (adb failure is a domain failure)", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new AdbExecError(["devices", "-l"], 1, "", "adb: device offline");
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "");
    expect(payload.error).toBe("adb_command_failed");
    expect(typeof payload.message).toBe("string");
  });

  it("AdbNotFoundError → isError:true with error:adb_not_found", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new AdbNotFoundError(["$(which adb)"]);
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "").error).toBe("adb_not_found");
  });

  it("SourceError → isError:true with error:rg_not_found (chain-M failure is a domain failure)", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new RgNotFoundError(["$(which rg)"]);
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "").error).toBe("rg_not_found");
  });

  it("ProjectRootMissingError → isError:true with error:project_root_missing", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new ProjectRootMissingError();
    });
    const result = await wrapped({});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "").error).toBe("project_root_missing");
  });

  it("non-domain throw propagates as a genuine error", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => {
      throw new Error("unexpected bug");
    });
    await expect(wrapped({})).rejects.toThrow("unexpected bug");
  });

  it("rejects when handler output violates the declared outputSchema", async () => {
    const wrapped = wrapToolHandler(baseConfig(), async () => ({
      structuredContent: { devices: "not-an-array" } as unknown as { devices: string[] },
    }));
    await expect(wrapped({})).rejects.toThrow();
  });
});
