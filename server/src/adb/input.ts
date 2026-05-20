import { runAdb } from "./adb.ts";

/**
 * Interaction primitives — `adb shell input *` for pointer / key events, and
 * the ADBKeyBoard helper IME for text (amendments § B: no AccessibilityService,
 * no bespoke on-device helper — ADBKeyBoard is an off-the-shelf one). Every
 * call addresses a single device by serial; coordinate / keycode validation is
 * the tool layer's job (Zod `.strict()` + bounds), so these wrappers stay thin.
 */

/**
 * ADBKeyBoard's IME id. Text is delivered as a broadcast that ADBKeyBoard turns
 * into an `InputConnection.commitText`, so ADBKeyBoard must be the device's
 * *active* IME — its broadcast receiver only lives inside the bound IME
 * service. https://github.com/senzhk/ADBKeyBoard
 */
export const ADB_KEYBOARD_IME = "com.android.adbkeyboard/.AdbIME";

/**
 * Encode free text for ADBKeyBoard's `ADB_INPUT_B64` broadcast: UTF-8 bytes →
 * base64. The base64 alphabet (`A-Za-z0-9+/=`) carries no shell metacharacter
 * and no space, so the encoded string survives the device shell untouched —
 * one code path types every input alike: ASCII, CJK, emoji, quotes, newlines.
 * This is why `input_text` needs no per-character escaping or ASCII/Unicode
 * branching.
 */
export function encodeInputB64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** `adb shell input tap <x> <y>`. */
export async function inputTap(deviceSerial: string, x: number, y: number): Promise<void> {
  await runAdb(["-s", deviceSerial, "shell", "input", "tap", String(x), String(y)], {
    timeoutMs: 10_000,
  });
}

/**
 * Read the device's current default IME id
 * (`settings get secure default_input_method`). The value is returned trimmed;
 * a device with no IME selected reads back the literal string `"null"`.
 */
export async function getDefaultIme(deviceSerial: string): Promise<string> {
  const result = await runAdb(
    ["-s", deviceSerial, "shell", "settings", "get", "secure", "default_input_method"],
    { timeoutMs: 10_000 },
  );
  return result.stdout.trim();
}

/**
 * Best-effort: enable `imeId`, then select it as the device's active IME.
 * `enable` precedes `set` because `set` is rejected for an IME that was never
 * enabled. Both steps tolerate a non-zero exit (`allowNonZero`) — an unknown
 * IME id is reported by `ime` on stderr without changing the setting, so the
 * caller verifies the outcome with {@link getDefaultIme} rather than trusting
 * the exit code.
 */
export async function selectIme(deviceSerial: string, imeId: string): Promise<void> {
  await runAdb(["-s", deviceSerial, "shell", "ime", "enable", imeId], {
    timeoutMs: 10_000,
    allowNonZero: true,
  });
  await runAdb(["-s", deviceSerial, "shell", "ime", "set", imeId], {
    timeoutMs: 10_000,
    allowNonZero: true,
  });
}

/**
 * Type `text` into the focused field via ADBKeyBoard's `ADB_INPUT_B64`
 * broadcast. Types the *real* text; redaction of the recorded command / event
 * is the `input_text` tool's job (Phase 5 gate: this layer must not be trusted
 * to scrub).
 *
 * Preconditions the caller owns: ADBKeyBoard is the active IME (a broadcast to
 * an inactive ADBKeyBoard is silently dropped — `am broadcast` still exits 0),
 * and a field is focused on screen.
 */
export async function inputText(deviceSerial: string, text: string): Promise<void> {
  await runAdb(
    [
      "-s",
      deviceSerial,
      "shell",
      "am",
      "broadcast",
      "-a",
      "ADB_INPUT_B64",
      "--es",
      "msg",
      encodeInputB64(text),
    ],
    { timeoutMs: 15_000 },
  );
}

/** `adb shell input keyevent <keycode>` — `keycode` is a whitelisted `KEYCODE_*` name. */
export async function inputKeyevent(deviceSerial: string, keycode: string): Promise<void> {
  await runAdb(["-s", deviceSerial, "shell", "input", "keyevent", keycode], {
    timeoutMs: 10_000,
  });
}

/** `adb shell input swipe <x1> <y1> <x2> <y2> [durationMs]`. */
export async function inputSwipe(
  deviceSerial: string,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  durationMs?: number,
): Promise<void> {
  const shellArgs = ["input", "swipe", String(from.x), String(from.y), String(to.x), String(to.y)];
  if (durationMs !== undefined) shellArgs.push(String(durationMs));
  await runAdb(["-s", deviceSerial, "shell", ...shellArgs], { timeoutMs: 15_000 });
}
