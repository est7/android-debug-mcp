import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputKeyevent } from "../../adb/input.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

/**
 * The `send_key` whitelist (design-lock § C-9). The Zod enum *is* the
 * enforcement: keys that could leave the device awkward to recover —
 * `KEYCODE_SLEEP` / `KEYCODE_POWER` — simply cannot be named.
 */
const KEY_NAMES = [
  "BACK",
  "HOME",
  "ENTER",
  "DEL",
  "TAB",
  "MENU",
  "VOLUME_UP",
  "VOLUME_DOWN",
] as const;

type KeyName = (typeof KEY_NAMES)[number];

/** Maps each whitelisted key to its Android `KEYCODE_*` constant. */
const KEY_TO_KEYCODE: Record<KeyName, string> = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  DEL: "KEYCODE_DEL",
  TAB: "KEYCODE_TAB",
  MENU: "KEYCODE_MENU",
  VOLUME_UP: "KEYCODE_VOLUME_UP",
  VOLUME_DOWN: "KEYCODE_VOLUME_DOWN",
};

const inputSchema = z
  .object({
    runId: runIdInput,
    key: z.enum(KEY_NAMES),
  })
  .strict();

const outputSchema = z.object({ ts: z.string() }).strict();

const description = [
  "Send a single hardware/navigation key to the active session's device via `adb shell input keyevent`.",
  "",
  "Use when: the agent needs to press a key the touch surface cannot — go back, go home, confirm, delete.",
  `Args: \`runId\`; \`key\` — one of the whitelist: ${KEY_NAMES.join(", ")}.`,
  "Returns: `{ts}` — the ISO timestamp the key press was recorded at.",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `adb_command_failed` when the adb command fails.",
].join("\n");

export function registerSendKey(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_send_key",
    {
      title: "Send a key event",
      description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const session = requireConnectedSession(manager, input.runId);
      touch(session);

      const keycode = KEY_TO_KEYCODE[input.key];
      await inputKeyevent(session.deviceSerial, keycode);

      await session.appendCommand({ tool: "send_key", adb: `input keyevent ${keycode}` });
      const ts = await session.appendEvent({ type: "send_key", key: input.key });
      return ok({ ts });
    },
  );
}
