#!/usr/bin/env python3
"""Compare a new-implementation capture (AccountWireRecorder JSONL) against legacy baseline recordings.

Both sides are reduced to the same normalized projection per request: method, path, encryption, ordered
query keys with normalized values, login device header presence, decoded business fields and identity role.
Requests are grouped by (method, path, type/login_type/use); inside a group the SETS of distinct projections
are compared, because retry / refresh counts legitimately differ between runs. A projection the capture sends more
often than the baseline did (and more than once) is DUPLICATE: a double-sent code or login. The report holds no values
beyond the normalized ones (credentials are already "<r>").

    python3 tools/account-wire-diff/baseline_diff.py --baseline S03.jsonl [--baseline ...] --capture new.jsonl \
        [--only /user/login,/user/check-phone] --out report.json

Exit codes: 0 all groups match; 1 any MISSING / EXTRA / CHANGED / DUPLICATE; 2 malformed input.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import re
import sys

ALIAS = re.compile(r"^<[a-z#:]+[0-9]*>$|^<redacted>$")
# Values that depend on build, locale, clock or device; only key presence and position are compared.
VOLATILE = {"_mtime", "_random", "_sign", "_uid", "v", "vs", "sl", "l", "mcc", "smei_id", "uuid", "yidun_id",
            "device_name", "login_device_id"}
SENSITIVE = {"password", "new_pwd", "old_pwd", "code", "sms_code", "email_code", "prev_sms_code",
             "prev_email_code", "verify_code", "ext_token", "token", "_token", "appid", "phone", "email",
             "userid", "uid", "for_userid", "country_number", "validate", "ticket", "captcha_token"}
DEVICE_HEADERS = {"x-request-time", "x-request-device", "x-request-device-id", "x-request-agent",
                  "x-request-imei", "x-device-info"}
DISCRIMINATORS = ("type", "login_type", "use")
# Legacy had no candidate owner: a candidate signs exactly like the current identity it will become.
ROLE = {"Current": "Current", "Candidate": "Current", "Anonymous": "Anonymous", "Untagged": "Anonymous"}


def norm_value(key, value):
    if key in VOLATILE:
        return "*"
    if value == "":
        return ""
    if key in SENSITIVE or ALIAS.match(value):
        return "<r>"
    return value


def norm_pairs(pairs):
    return [[k, norm_value(k, v)] for k, v in pairs]


def norm_query(method, pairs):
    # A POST query is the injector's copy of the form body for server logs; legacy built the body from a HashMap,
    # so its order was incidental. Only GET query order is compared.
    query = norm_pairs(pairs)
    return sorted(query) if method == "POST" else query


def from_baseline(record):
    # A baseline recorded with the debug recorder (legacy pages still in the build, e.g. phase 5's B5.*) has the
    # capture format; the phase-0 recordings have the projection format.
    if "projection" not in record:
        return from_capture(record)
    p = record["projection"]
    wire = p["wire"]
    return dict(method=wire["method"], path=wire["path"], encrypted=wire["encrypted"],
                query=norm_query(wire["method"], wire["query"]),
                deviceHeaders=any(h[0].lower() in DEVICE_HEADERS for h in wire["headers"]),
                fields=sorted(norm_pairs(p["decoded"]["fields"])),
                role=ROLE[p["decoded"]["identity"]["role"]])


def from_capture(record):
    if "recorderError" in record:
        raise ValueError(f"recorder failed on {record['path']}: {record['recorderError']}")
    return dict(method=record["method"], path=record["path"], encrypted=record["encrypted"],
                query=norm_query(record["method"], record["query"]),
                deviceHeaders=any(h.lower() in DEVICE_HEADERS for h in record["headers"]),
                fields=sorted(norm_pairs(record["fields"])),
                role=ROLE[record["role"]])


def group_key(projection):
    fields = dict(projection["fields"])
    disc = ",".join(f"{k}={fields[k]}" for k in DISCRIMINATORS if k in fields)
    return f"{projection['method']} {projection['path']} [{disc}]"


def load(paths, convert, only):
    groups = {}
    for path in paths:
        for line in Path(path).read_text().splitlines():
            if not line.strip():
                continue
            projection = convert(json.loads(line))
            if only and projection["path"] not in only:
                continue
            groups.setdefault(group_key(projection), Counter())[json.dumps(projection, sort_keys=True)] += 1
    return groups


def diff(baseline, capture):
    report = []
    for key in sorted(baseline.keys() | capture.keys()):
        old_counts, new_counts = baseline.get(key, Counter()), capture.get(key, Counter())
        old, new = set(old_counts), set(new_counts)
        repeated = sorted(p for p in new if new_counts[p] > max(1, old_counts[p]))
        if not new:
            status = "MISSING"
        elif not old:
            status = "EXTRA"
        elif old != new:
            status = "CHANGED"
        else:
            status = "DUPLICATE" if repeated else "MATCH"
        entry = dict(group=key, status=status)
        if status == "DUPLICATE":
            entry["repeated"] = [dict(times=new_counts[p], baselineTimes=old_counts[p], projection=json.loads(p))
                                 for p in repeated]
        if status == "CHANGED":
            entry["onlyBaseline"] = [json.loads(x) for x in sorted(old - new)]
            entry["onlyCapture"] = [json.loads(x) for x in sorted(new - old)]
        elif status != "MATCH":
            entry["projections"] = [json.loads(x) for x in sorted(old or new)]
        report.append(entry)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", action="append", required=True)
    parser.add_argument("--capture", action="append", required=True)
    parser.add_argument("--only", default="", help="comma separated paths to compare")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    only = {p for p in args.only.split(",") if p}
    try:
        report = diff(load(args.baseline, from_baseline, only), load(args.capture, from_capture, only))
    except (OSError, KeyError, ValueError) as error:
        print(f"ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(dict(schemaVersion=1, groups=report), indent=2, ensure_ascii=False) + "\n")
    counts = {s: sum(e["status"] == s for e in report) for s in ("MATCH", "CHANGED", "MISSING", "EXTRA", "DUPLICATE")}
    print(json.dumps(counts, sort_keys=True))
    return 0 if counts["MATCH"] == len(report) else 1


if __name__ == "__main__":
    sys.exit(main())
