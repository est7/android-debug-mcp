import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDevicesL } from "../../src/adb/devices.ts";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adb");

function load(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

describe("parseDevicesL", () => {
  it("returns an empty list when only the header is present", () => {
    const entries = parseDevicesL(load("devices-none.txt"));
    expect(entries).toEqual([]);
  });

  it("parses a single authorized device with -l metadata", () => {
    const entries = parseDevicesL(load("devices-one.txt"));
    expect(entries).toEqual([
      {
        deviceSerial: "951a20a2",
        state: "device",
        transportId: "1",
        product: "alioth",
        model: "M2012K11AC",
        device: "alioth",
      },
    ]);
  });

  it("parses emulator + unauthorized + offline + no-permissions in one batch", () => {
    const entries = parseDevicesL(load("devices-two.txt"));
    const byState = new Map(entries.map((e) => [e.deviceSerial, e]));

    expect(byState.get("emulator-5554")).toMatchObject({
      state: "device",
      product: "sdk_gphone64_arm64",
      model: "sdk_gphone64_arm64",
      device: "emu64a",
      transportId: "2",
    });
    expect(byState.get("951a20a2")).toMatchObject({
      state: "unauthorized",
      transportId: "3",
    });
    expect(byState.get("99031FFAZ005ZG")).toMatchObject({
      state: "offline",
      transportId: "4",
    });
    // "no permissions" must be recognized as a single state despite the space.
    expect(byState.get("ZX1G226PMC")?.state).toBe("no permissions");
  });

  it("skips blank lines and header variants gracefully", () => {
    const stdout = "List of devices attached\n\n\n   \n";
    expect(parseDevicesL(stdout)).toEqual([]);
  });

  it("returns state=unknown when adb prints an unexpected line", () => {
    const stdout = "List of devices attached\nweirdserial garbage extra fields\n";
    const entries = parseDevicesL(stdout);
    expect(entries).toEqual([{ deviceSerial: "weirdserial", state: "unknown" }]);
  });

  it("tolerates CRLF line endings (Windows-captured fixtures)", () => {
    const stdout = "List of devices attached\r\nABCDEF\tdevice\ttransport_id:9\r\n";
    const entries = parseDevicesL(stdout);
    expect(entries).toEqual([
      {
        deviceSerial: "ABCDEF",
        state: "device",
        transportId: "9",
      },
    ]);
  });

  it("recognizes authorizing / recovery / sideload / bootloader states", () => {
    const stdout = [
      "List of devices attached",
      "AUTHZ1                authorizing transport_id:11",
      "RECOV1                recovery transport_id:12",
      "SIDE1                 sideload transport_id:13",
      "BOOT1                 bootloader transport_id:14",
      "",
    ].join("\n");
    const entries = parseDevicesL(stdout);
    expect(entries.map((e) => [e.deviceSerial, e.state])).toEqual([
      ["AUTHZ1", "authorizing"],
      ["RECOV1", "recovery"],
      ["SIDE1", "sideload"],
      ["BOOT1", "bootloader"],
    ]);
    for (const e of entries) {
      expect(e.transportId).toMatch(/^\d+$/);
    }
  });
});
