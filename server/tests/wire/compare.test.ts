import { describe, expect, it } from "vitest";
import {
  MalformedWireInputError,
  type Pair,
  type Projection,
  compareProjections,
  fromBaseline,
  fromCapture,
  groupKey,
  normValue,
  pyJson,
} from "../../src/wire/compare.ts";

type Rec = Record<string, unknown>;

function baselineRecord(fields: Pair[], role = "Anonymous", query?: Pair[], method = "GET"): Rec {
  return {
    projection: {
      wire: {
        method,
        path: "/user/check-phone",
        encrypted: false,
        query: query ?? [
          ["phone", "<phone:7>"],
          ["inland", "0"],
          ["v", "545"],
          ["_mtime", "<var>"],
        ],
        headers: [["Host", "h"]],
      },
      decoded: { fields, identity: { role, account: "", credential: "" } },
    },
  };
}

function captureRecord(fields: Pair[], role = "Anonymous", query?: Pair[], method = "GET"): Rec {
  return {
    method,
    path: "/user/check-phone",
    encrypted: false,
    query: query ?? [
      ["phone", "<redacted>"],
      ["inland", "0"],
      ["v", "547"],
      ["_mtime", "1"],
    ],
    headers: ["Host"],
    fields,
    role,
  };
}

function statuses(baseline: Rec[], capture: Rec[]): string[] {
  return compareProjections(baseline.map(fromBaseline), capture.map(fromCapture)).groups.map(
    (g) => g.status,
  );
}

const FIELDS: Pair[] = [
  ["inland", "0"],
  ["phone", "<phone:7>"],
];
const NEW_FIELDS: Pair[] = [
  ["inland", "0"],
  ["phone", "<redacted>"],
];

// The cases of tools/account-wire-diff/test_baseline_diff.py, one for one.
describe("comparator rules (ported from test_baseline_diff.py)", () => {
  it("the same request matches across versions and aliases", () => {
    expect(statuses([baselineRecord(FIELDS)], [captureRecord(NEW_FIELDS)])).toEqual(["MATCH"]);
  });

  it("a changed literal field is reported", () => {
    const changed: Pair[] = [
      ["inland", "1"],
      ["phone", "<redacted>"],
    ];
    expect(statuses([baselineRecord(FIELDS)], [captureRecord(changed)])).toEqual(["CHANGED"]);
  });

  it("empty versus present credential is reported", () => {
    const empty: Pair[] = [
      ["inland", "0"],
      ["phone", ""],
    ];
    expect(statuses([baselineRecord(FIELDS)], [captureRecord(empty)])).toEqual(["CHANGED"]);
  });

  it("a missing field is reported", () => {
    expect(statuses([baselineRecord(FIELDS)], [captureRecord([["inland", "0"]])])).toEqual([
      "CHANGED",
    ]);
  });

  it("GET query order is compared", () => {
    const reordered: Pair[] = [
      ["inland", "0"],
      ["phone", "<redacted>"],
      ["v", "547"],
      ["_mtime", "1"],
    ];
    expect(
      statuses([baselineRecord(FIELDS)], [captureRecord(NEW_FIELDS, "Anonymous", reordered)]),
    ).toEqual(["CHANGED"]);
  });

  it("POST query order is not compared", () => {
    const reordered: Pair[] = [
      ["inland", "0"],
      ["phone", "<redacted>"],
      ["v", "547"],
      ["_mtime", "1"],
    ];
    expect(
      statuses(
        [baselineRecord(FIELDS, "Anonymous", undefined, "POST")],
        [captureRecord(NEW_FIELDS, "Anonymous", reordered, "POST")],
      ),
    ).toEqual(["MATCH"]);
  });

  it("identity role is compared and a candidate counts as current", () => {
    expect(statuses([baselineRecord(FIELDS)], [captureRecord(NEW_FIELDS, "Current")])).toEqual([
      "CHANGED",
    ]);
    expect(
      statuses([baselineRecord(FIELDS, "Current")], [captureRecord(NEW_FIELDS, "Candidate")]),
    ).toEqual(["MATCH"]);
  });

  it("missing and extra groups", () => {
    const other = { ...captureRecord(NEW_FIELDS), path: "/user/check-email" };
    expect(statuses([baselineRecord(FIELDS)], [other]).sort()).toEqual(["EXTRA", "MISSING"]);
  });

  it("a request sent more often than legacy is a duplicate", () => {
    expect(
      statuses([baselineRecord(FIELDS)], [captureRecord(NEW_FIELDS), captureRecord(NEW_FIELDS)]),
    ).toEqual(["DUPLICATE"]);
  });

  it("a repeat legacy also made is not a duplicate", () => {
    expect(
      statuses(
        [baselineRecord(FIELDS), baselineRecord(FIELDS)],
        [captureRecord(NEW_FIELDS), captureRecord(NEW_FIELDS)],
      ),
    ).toEqual(["MATCH"]);
  });

  it("a baseline recorded by the recorder is read as a capture", () => {
    const legacy = captureRecord(NEW_FIELDS);
    expect(statuses([legacy], [captureRecord(NEW_FIELDS)])).toEqual(["MATCH"]);
    const changed: Pair[] = [
      ["inland", "1"],
      ["phone", "<redacted>"],
    ];
    expect(statuses([legacy], [captureRecord(changed)])).toEqual(["CHANGED"]);
  });

  it("a recorder error is malformed input", () => {
    expect(() =>
      fromCapture({ path: "/user/login", recorderError: "IllegalStateException" }),
    ).toThrow(MalformedWireInputError);
  });
});

describe("normalization and grouping", () => {
  it("volatile keys are '*', credentials are '<r>' when present, empty stays empty", () => {
    expect(normValue("_sign", "abc")).toBe("*");
    expect(normValue("_sign", "")).toBe("*");
    expect(normValue("password", "x")).toBe("<r>");
    expect(normValue("password", "")).toBe("");
    expect(normValue("anything", "<uid:3>")).toBe("<r>");
    expect(normValue("anything", "<redacted>")).toBe("<r>");
    expect(normValue("type", "login")).toBe("login");
  });

  const projection = (fields: Pair[]): Projection => ({
    method: "GET",
    path: "/p",
    encrypted: false,
    query: [],
    deviceHeaders: false,
    fields,
    role: "Current",
  });

  it("groups by type / login_type / use, and the discriminators can be overridden", () => {
    const p = projection([
      ["login_type", "phone"],
      ["use", "login"],
      ["zzz", "1"],
    ]);
    expect(groupKey(p)).toBe("GET /p [login_type=phone,use=login]");
    expect(groupKey(p, ["zzz"])).toBe("GET /p [zzz=1]");
    expect(groupKey(p, [])).toBe("GET /p []");
  });

  it("serializes like json.dumps(sort_keys=True), escaping non-ASCII", () => {
    expect(pyJson({ b: [1, true, null], a: "é😀\n" })).toBe(
      '{"a": "\\u00e9\\ud83d\\ude00\\n", "b": [1, true, null]}',
    );
  });
});

describe("role handling when a record has none", () => {
  const withRole = (role: string | null) => ({ ...captureRecord(NEW_FIELDS), role });

  it("accepts a null role and leaves role out of the comparison on both sides", () => {
    const result = compareProjections(
      [fromBaseline(baselineRecord(FIELDS, "Current"))],
      [fromCapture(withRole(null))],
    );
    expect(result.roleCompared).toBe(false);
    expect(result.groups.map((g) => g.status)).toEqual(["MATCH"]);
  });

  it("still compares role when every record has one", () => {
    const result = compareProjections(
      [fromBaseline(baselineRecord(FIELDS, "Current"))],
      [fromCapture(withRole("Anonymous"))],
    );
    expect(result.roleCompared).toBe(true);
    expect(result.groups.map((g) => g.status)).toEqual(["CHANGED"]);
  });

  it("rejects an unknown role string", () => {
    expect(() => fromCapture(withRole("Admin"))).toThrow(MalformedWireInputError);
  });
});
