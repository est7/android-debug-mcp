import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Aliaser, isSecretKey, parseForm, scrub } from "../../src/wire/project.ts";
import { buildSnapshot, writeSnapshot } from "../../src/wire/snapshot.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/wire/http_synthetic.jsonl",
);

// Raw values planted in the fixture that must never reach a snapshot.
const SECRETS = [
  "hunter2",
  "15550001111",
  "15550002222",
  "15550003333",
  "a@example.test",
  "654321",
  "111222",
  "1234",
  "ck-1",
  "tok-9",
  "dev-abc",
  "dev-smei-1",
  "uuid-1",
  "yd-1",
  "Pixel Test",
  "cmFuZG9t",
  "c2lnbg==",
];

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "adm-wire-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("redaction by key name", () => {
  it("treats credentials, codes, tokens and device ids as secret", () => {
    for (const key of [
      "password",
      "prev_sms_code",
      "verify_code",
      "captcha",
      "c_key",
      "access_token",
      "_sign",
      "_random",
      "smei_id",
      "login_device_id",
      "ext_token",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of [
      "type",
      "login_type",
      "use",
      "inland",
      "infos",
      "gender",
      "has_whatsapp",
      "p",
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it("keeps empty values empty and aliases uid / phone / email stably", () => {
    const aliaser = new Aliaser();
    expect(scrub(aliaser, "password", "")).toBe("");
    expect(scrub(aliaser, "password", "x")).toBe("<redacted>");
    expect(scrub(aliaser, "phone", "111")).toBe("<phone:1>");
    expect(scrub(aliaser, "phone", "222")).toBe("<phone:2>");
    expect(scrub(aliaser, "phone", "111")).toBe("<phone:1>");
    expect(scrub(aliaser, "uid", "9")).toBe("<uid:1>");
    expect(scrub(aliaser, "userid", "9")).toBe("<uid:1>");
    expect(scrub(aliaser, "email", "e")).toBe("<email:1>");
    expect(scrub(aliaser, "type", "login")).toBe("login");
    expect(aliaser.counts()).toEqual({ phone: 2, uid: 1, email: 1 });
  });

  it("aliases a long id echoed whole under another key, but not short values", () => {
    const aliaser = new Aliaser();
    scrub(aliaser, "uid", "12345678");
    scrub(aliaser, "uid", "7");
    expect(scrub(aliaser, "created_in_id", "12345678")).toBe("<uid:1>");
    expect(scrub(aliaser, "created_in_id", "7")).toBe("7");
    expect(scrub(aliaser, "created_in_id", "x12345678")).toBe("x12345678");
    // A secret key stays redacted, not aliased.
    expect(scrub(aliaser, "token", "12345678")).toBe("<redacted>");
  });

  it("parses a form body in order, keeping duplicates and decoding '+' and %xx", () => {
    expect(parseForm("a=1&b=x+y&a=%32&c")).toEqual([
      ["a", "1"],
      ["b", "x y"],
      ["a", "2"],
      ["c", ""],
    ]);
  });
});

describe("snapshot over the synthetic http log", () => {
  it("projects in the recorder shape, ordered by time, skipping the half-written tail", async () => {
    const { records, stats } = await buildSnapshot({ files: [FIXTURE] });
    expect(stats.linesRead).toBe(10);
    expect(stats.linesSkipped).toBe(1);
    expect(records.map((r) => [r.seq, r.path])).toEqual([
      [1, "/user/check-phone"], // run r0, earliest tsMs
      [2, "/user/info"],
      [3, "/user/check-phone"],
      [4, "/user/login"],
      [5, "/user/send-email"],
      [6, "/user/bind-phone"],
      [7, "/system/time"],
      [8, "/user/info"],
      [9, "/user/logout"],
    ]);
    expect(records.map((r) => r.time)).toEqual(
      [...records.map((r) => r.time)].sort((a, b) => a - b),
    );
  });

  it("builds fields from decoded (encrypted), the query (plain) and the form body (POST)", async () => {
    const { records } = await buildSnapshot({ files: [FIXTURE] });
    const byPath = (path: string) => records.filter((r) => r.path === path);

    const info = byPath("/user/info")[0];
    expect(info?.encrypted).toBe(true);
    // _mtime / b_vpn dropped; uid aliased; sorted by key.
    expect(info?.fields).toEqual([
      ["infos", "heart_beat"],
      ["uid", "<uid:1>"],
    ]);

    const phone = byPath("/user/check-phone")[1];
    expect(phone?.encrypted).toBe(false);
    expect(phone?.fields).toEqual([
      ["inland", "0"],
      ["phone", "<phone:2>"],
    ]);

    const login = byPath("/user/login")[0];
    expect(login?.encrypted).toBe(false);
    expect(login?.bodyMediaType).toBe("application/x-www-form-urlencoded");
    expect(login?.fields).toEqual([
      ["inland", "0"],
      ["login_device_id", "<redacted>"],
      ["login_type", "phone"],
      ["password", "<redacted>"],
      ["phone", "<phone:2>"],
      ["type", "login"],
    ]);
    // The password copied into the URL query is redacted there too.
    expect(login?.query.find(([k]) => k === "password")).toEqual(["password", "<redacted>"]);
  });

  it("gives the same value the same alias across requests and keeps device ids out of the query", async () => {
    const { records, stats } = await buildSnapshot({ files: [FIXTURE] });
    const uids = records
      .flatMap((r) => r.fields)
      .filter(([k]) => k === "uid")
      .map(([, v]) => v);
    expect(new Set(uids)).toEqual(new Set(["<uid:1>"]));
    const info = records.find((r) => r.path === "/user/info");
    expect(info?.query.find(([k]) => k === "smei_id")).toEqual(["smei_id", "<redacted>"]);
    expect(info?.query.find(([k]) => k === "_sign")).toEqual(["_sign", "<redacted>"]);
    expect(stats.aliases).toEqual({ uid: 2, phone: 3, email: 1 });
  });

  it("redacts inside nested decoded objects", async () => {
    const { records } = await buildSnapshot({ files: [FIXTURE] });
    const bind = records.find((r) => r.path === "/user/bind-phone");
    const ext = bind?.fields.find(([k]) => k === "ext")?.[1] ?? "";
    expect(JSON.parse(ext)).toEqual({
      access_token: "<redacted>",
      name: "visible",
      contact: { email: "<email:1>" },
    });
  });

  it("takes the role from request.owner.role and leaves it null otherwise", async () => {
    const { records, stats } = await buildSnapshot({ files: [FIXTURE] });
    expect(stats.withRole).toBe(1);
    expect(records.filter((r) => r.role !== null).map((r) => [r.path, r.role])).toEqual([
      ["/user/info", "Current"],
    ]);
  });

  it("filters by path and window and counts what it dropped", async () => {
    const { records, stats } = await buildSnapshot({
      files: [FIXTURE],
      only: new Set(["/user/info", "/user/login"]),
      window: { fromTsMs: 2000, toTsMs: 4000 },
    });
    expect(records.map((r) => r.path)).toEqual(["/user/info", "/user/login"]);
    expect(stats.outsideWindow).toBe(6);
    expect(stats.outsidePaths).toBe(1);
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("writes no raw secret value to the snapshot or its sidecar", async () => {
    const snapshot = await buildSnapshot({ files: [FIXTURE] });
    const path = await writeSnapshot({
      dir: scratch,
      label: "cand",
      snapshot,
      meta: { window: {} },
    });
    const text =
      readFileSync(path, "utf8") + readFileSync(join(scratch, "cand.snapshot.json"), "utf8");
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(text.split("\n").filter((l) => l !== "" && l.startsWith('{"method"'))).toHaveLength(9);
  });

  it("rejects a label that could escape the folder", async () => {
    const snapshot = await buildSnapshot({ files: [FIXTURE] });
    await expect(
      writeSnapshot({ dir: scratch, label: "../x", snapshot, meta: {} }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
