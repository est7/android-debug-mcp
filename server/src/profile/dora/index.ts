import type { WirePolicy } from "../../wire/policy.ts";
import { poppoHttpSource } from "../poppo-vone/poppo_http/source.ts";
import type { Profile } from "../types.ts";

/**
 * DoraLive's wire (mimi gateway): its common parameters are `CommonParamNames` in DoraLive's `core:network`
 * (protocol §2), sent on every request; the caller's own fields are always in `request.decoded` (the plain body
 * before encryption, a route call's `params_json` read out, a GET's own query); one route endpoint serves many calls,
 * told apart by `request.route` (see `wire/compare.ts`'s group key), so no field discriminates.
 */
export const DORA_WIRE: WirePolicy = {
  globalKeys: new Set([
    "_uid",
    "_sign",
    "p",
    "device_name",
    "c",
    "v",
    "vs",
    "sl",
    "l",
    "mcc",
    "tz",
    "r",
    "gr",
    "ar",
    "n",
    "uuid",
    "b_vpn",
    "requestId",
    "smei_id",
    "yidun_id",
    "emulator_status",
    "emulator_score",
    "dev",
    "yidun_token",
  ]),
  // Everything of the device, build, locale, network or clock; `p`, `c` and `dev` are compared (a platform or
  // product or encryption switch changing is a finding).
  volatileKeys: new Set([
    "_uid",
    "_sign",
    "device_name",
    "v",
    "vs",
    "sl",
    "l",
    "mcc",
    "tz",
    "r",
    "gr",
    "ar",
    "n",
    "uuid",
    "b_vpn",
    "requestId",
    "smei_id",
    "yidun_id",
    "emulator_status",
    "emulator_score",
    "yidun_token",
  ]),
  deviceHeaders: new Set(["x-device", "x-platform"]),
  discriminators: [],
  fieldsFromDecoded: true,
};

/**
 * `dora` profile: DoraLive's debug build writes the same `http_*.jsonl` contract (v1 rev6, DoraLive appendix §9.2) to
 * the same external files directory, so the `poppo_http` source (named for the schema's first producer) reads it as
 * it is. What differs is the wire ({@link DORA_WIRE}) and the console noise: DoraLive prints Poppo's section tags
 * too, and only the two digests belong on a timeline.
 */
export const DORA_PROFILE: Profile = {
  name: "dora",
  evidenceSources: [poppoHttpSource],
  logcatTimelineExcludeTags: [
    "http/request/header",
    "http/request/param",
    "http/request/body",
    "http/response/header",
    "http/response/body",
  ],
  wire: DORA_WIRE,
};
