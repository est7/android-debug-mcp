import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ADB_KEYBOARD_IME,
  encodeInputB64,
  getDefaultIme,
  inputText,
  selectIme,
} from "../../adb/input.ts";
import { REDACTED, redactInputText, redactString } from "../../redact/redact.ts";
import type { SessionManager } from "../../session/manager.ts";
import { registerDebugTool } from "../register.ts";
import { ToolDomainError } from "../toolError.ts";
import { ok, requireConnectedSession, runIdInput, touch } from "./_shared.ts";

const inputSchema = z
  .object({
    runId: runIdInput,
    text: z.string().min(1, "text must be non-empty").max(4096, "text too long"),
    sensitive: z.boolean().optional(),
  })
  .strict();

const outputSchema = z
  .object({
    ts: z.string(),
    redacted: z.boolean(),
  })
  .strict();

const description = [
  "Type text into the focused field of the active session's app via the ADBKeyBoard helper IME.",
  "",
  "Use when: the agent needs to enter text during a debug run — a search query, a form field, credentials. One path handles every input: ASCII, CJK, emoji, punctuation.",
  "Args: `runId`; `text` (1-4096 chars); optional `sensitive` — set true for a secret so the run record stores a length placeholder, never the text.",
  "Returns: `{ts, redacted}` — `redacted` is true when the recorded evidence was placeheld (because `sensitive` was set, or a sensitive word was detected).",
  "Errors: `no_active_session` for an unknown runId; `device_disconnected` when the device has dropped; `input_method_unavailable` when ADBKeyBoard is not installed or cannot be made the device IME; `adb_not_found` when the adb binary is missing; `adb_command_failed` when an adb command fails.",
].join("\n");

/**
 * Ensure ADBKeyBoard is the device's active IME — the broadcast `inputText`
 * sends is only honored while ADBKeyBoard's IME service is bound. Returns true
 * when a switch was performed (so the caller can record it in the audit log).
 *
 * Throws `input_method_unavailable` when the switch did not take — almost
 * always because the ADBKeyBoard APK is not installed on the device.
 */
async function ensureAdbKeyboard(deviceSerial: string): Promise<boolean> {
  if ((await getDefaultIme(deviceSerial)) === ADB_KEYBOARD_IME) return false;
  await selectIme(deviceSerial, ADB_KEYBOARD_IME);
  if ((await getDefaultIme(deviceSerial)) !== ADB_KEYBOARD_IME) {
    throw new ToolDomainError(
      "input_method_unavailable",
      "ADBKeyBoard is not the active input method and could not be selected. Install the " +
        "ADBKeyBoard APK (package com.android.adbkeyboard) on the device, then retry. " +
        "See https://github.com/senzhk/ADBKeyBoard.",
      { deviceSerial },
    );
  }
  return true;
}

export function registerInputText(server: McpServer, manager: SessionManager): void {
  registerDebugTool(
    server,
    "android_debug_input_text",
    {
      title: "Type text",
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

      // The text broadcast is dropped unless ADBKeyBoard owns the IME slot.
      // A switch is a real device-state change, so it is audited like any
      // other adb command.
      const switched = await ensureAdbKeyboard(session.deviceSerial);
      if (switched) {
        await session.appendCommand({ tool: "input_text", adb: `ime set ${ADB_KEYBOARD_IME}` });
      }

      // Phase 5 gate: this tool MUST decide redaction for itself — the generic
      // `appendCommand` → `redactValue` pass is blind here. The recorded command
      // base64-encodes the text, and base64 hides the `Authorization:` /
      // `Cookie:` / `token=` keywords that `redactString` keys on, so a leaked
      // credential would survive that pass as trivially decodable base64.
      // `recordedText` is therefore placeheld whenever ANY redaction layer
      // would fire on the raw text: an explicit `sensitive` flag, the input_text
      // heuristic (open decision #8 — the heuristic wins, a caller cannot
      // un-redact by omitting the flag), or the embedded-credential string
      // matcher (`redactString` changes the text).
      const isSecret =
        input.sensitive === true ||
        redactInputText(input.text).redacted ||
        redactString(input.text) !== input.text;
      const recordedText = isSecret ? `${REDACTED}${input.text.length}` : input.text;

      // The device is sent the REAL text; the recorded command base64-encodes
      // only the placeheld `recordedText`, so a secret never reaches disk even
      // in the (trivially decodable) base64 form.
      await inputText(session.deviceSerial, input.text);

      await session.appendCommand({
        tool: "input_text",
        adb: `am broadcast -a ADB_INPUT_B64 --es msg ${encodeInputB64(recordedText)}`,
        redacted: isSecret,
      });
      const ts = await session.appendEvent({
        type: "input_text",
        text: recordedText,
        length: input.text.length,
        redacted: isSecret,
      });
      return ok({ ts, redacted: isSecret });
    },
  );
}
