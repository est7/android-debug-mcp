import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listDevices } from "../../adb/devices.ts";
import { registerDebugTool } from "../register.ts";

const inputSchema = z.object({}).strict();

const deviceStateSchema = z.enum([
  "device",
  "offline",
  "unauthorized",
  "no permissions",
  "authorizing",
  "recovery",
  "sideload",
  "bootloader",
  "unknown",
]);

const outputSchema = z
  .object({
    devices: z.array(
      z
        .object({
          deviceSerial: z.string().min(1),
          state: deviceStateSchema,
          model: z.string().min(1).nullable(),
          apiLevel: z.number().int().min(1).max(999).nullable(),
          abi: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const description = [
  "List Android devices currently visible to adb on this host, including emulators, offline, and unauthorized entries.",
  "",
  "Use when: the agent needs to pick a `deviceSerial` before calling `android_debug_start_session`, or wants to verify a device just connected/disconnected.",
  "Args: none.",
  "Returns: `{devices: [{deviceSerial, state, model, apiLevel, abi}]}`. `model`/`apiLevel`/`abi` are populated via `getprop` only for entries in state `device`; otherwise they are `null`.",
  "Errors: throws `adb_not_found` when the adb binary cannot be located via `ADB_PATH` env or PATH lookup. Underlying `adb devices -l` failures surface as `adb_command_failed`.",
].join("\n");

export function registerListDevices(server: McpServer): void {
  registerDebugTool(
    server,
    "android_debug_list_devices",
    {
      title: "List adb devices",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const devices = await listDevices();
      return { structuredContent: { devices } };
    },
  );
}
