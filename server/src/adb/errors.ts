export type AdbErrorCode = "adb_not_found" | "adb_command_failed" | "device_disconnected";

export class AdbError extends Error {
  readonly code: AdbErrorCode;
  constructor(code: AdbErrorCode, message: string) {
    super(message);
    this.name = "AdbError";
    this.code = code;
  }
}

export class AdbNotFoundError extends AdbError {
  constructor(searchedPaths: readonly string[]) {
    super(
      "adb_not_found",
      `adb binary not found. Tried: ${searchedPaths.join(", ")}. Install Android platform-tools, or set ADB_PATH to point at the binary.`,
    );
    this.name = "AdbNotFoundError";
  }
}

export class AdbExecError extends AdbError {
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderrText: string;
  readonly stdoutText: string;
  constructor(args: readonly string[], exitCode: number, stdoutText: string, stderrText: string) {
    super(
      "adb_command_failed",
      `adb ${args.join(" ")} exited ${exitCode}: ${stderrText.trim() || stdoutText.trim() || "<no output>"}`,
    );
    this.name = "AdbExecError";
    this.args = args;
    this.exitCode = exitCode;
    this.stdoutText = stdoutText;
    this.stderrText = stderrText;
  }
}

export class DeviceDisconnectedError extends AdbError {
  readonly deviceSerial: string;
  constructor(deviceSerial: string, detail?: string) {
    super(
      "device_disconnected",
      `Device ${deviceSerial} is not reachable${detail ? `: ${detail}` : ""}.`,
    );
    this.name = "DeviceDisconnectedError";
    this.deviceSerial = deviceSerial;
  }
}
