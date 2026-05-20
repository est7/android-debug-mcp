import { isValidRunId } from "./runId.ts";

export type IdentityErrorCode =
  | "invalid_package_name"
  | "invalid_run_id"
  | "invalid_device_serial"
  | "invalid_user_id";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly field: string;
  readonly value: unknown;
  constructor(code: IdentityErrorCode, field: string, value: unknown, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.field = field;
    this.value = value;
  }
}

/**
 * Strings that come in through MCP tool input (`packageName`, `runId`,
 * `deviceSerial`) become path segments under `runRoot` and lockfile names
 * under `getLocksRoot()`. Without a contract at this layer, a malformed value
 * containing `/` or `..` can escape either root. These validators are the
 * single chokepoint — call them at every boundary that uses an identity value
 * as path material.
 *
 * Design:
 *   - Reject `..`, `/`, `\\`, NUL, leading `.`, and empty values for all
 *     identity types (path-safety baseline).
 *   - Each type then applies its own format rule (Android package syntax,
 *     runId regex, adb serial allowlist, non-negative integer userId).
 *   - Errors are typed (`IdentityError`) so callers can branch.
 */

const PACKAGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const DEVICE_SERIAL_RE = /^[A-Za-z0-9._:-]+$/;
// Adb's documented serial alphabet includes alnum + `.` + `:` (TCP form
// `127.0.0.1:5555`) + `-` + `_`. We explicitly forbid `/`, `..`, leading `.`,
// and whitespace via the regex anchor.

export function assertSafePackageName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new IdentityError(
      "invalid_package_name",
      "packageName",
      value,
      "packageName must be a non-empty string.",
    );
  }
  if (hasPathTraversal(value) || value.startsWith(".")) {
    throw new IdentityError(
      "invalid_package_name",
      "packageName",
      value,
      `packageName ${JSON.stringify(value)} contains path-traversal characters.`,
    );
  }
  if (!PACKAGE_NAME_RE.test(value)) {
    throw new IdentityError(
      "invalid_package_name",
      "packageName",
      value,
      `packageName ${JSON.stringify(value)} does not match Android package syntax (^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$).`,
    );
  }
}

export function assertSafeRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new IdentityError("invalid_run_id", "runId", value, "runId must be a non-empty string.");
  }
  if (hasPathTraversal(value)) {
    throw new IdentityError(
      "invalid_run_id",
      "runId",
      value,
      `runId ${JSON.stringify(value)} contains path-traversal characters.`,
    );
  }
  if (!isValidRunId(value)) {
    throw new IdentityError(
      "invalid_run_id",
      "runId",
      value,
      `runId ${JSON.stringify(value)} does not match the canonical format (mintRunId).`,
    );
  }
}

export function assertSafeDeviceSerial(value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new IdentityError(
      "invalid_device_serial",
      "deviceSerial",
      value,
      "deviceSerial must be a non-empty string.",
    );
  }
  if (hasPathTraversal(value) || value.startsWith(".")) {
    throw new IdentityError(
      "invalid_device_serial",
      "deviceSerial",
      value,
      `deviceSerial ${JSON.stringify(value)} contains path-traversal characters.`,
    );
  }
  if (!DEVICE_SERIAL_RE.test(value)) {
    throw new IdentityError(
      "invalid_device_serial",
      "deviceSerial",
      value,
      `deviceSerial ${JSON.stringify(value)} contains characters outside the allowed set [A-Za-z0-9._:-].`,
    );
  }
}

export function assertSafeUserId(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new IdentityError(
      "invalid_user_id",
      "userId",
      value,
      `userId must be a non-negative integer, got ${String(value)}.`,
    );
  }
}

function hasPathTraversal(value: string): boolean {
  if (value.includes("..")) return true;
  if (value.includes("/")) return true;
  if (value.includes("\\")) return true;
  if (value.includes("\0")) return true;
  return false;
}
