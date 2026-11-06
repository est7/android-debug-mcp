/**
 * What the request comparison needs to know about one app's wire (contract `docs/contracts/http-log-jsonl.md` §6):
 * the parameters it injects into every request, the ones whose values change by build / clock / device, the headers
 * that mark the device, the fields that split one endpoint into groups, and where the caller's own fields are.
 * It is the profile's business knowledge; the projection (`project.ts`) and the comparator (`compare.ts`) stay generic.
 *
 * {@link POPPO_WIRE} is what both did before profiles carried a policy (and what `baseline_diff.py` does), so a run
 * without one compares exactly as before.
 */
export interface WirePolicy {
  /** Parameters the app adds to every request: never the caller's fields. */
  readonly globalKeys: ReadonlySet<string>;
  /** Values that depend on build, locale, clock or device: only key presence and position are compared. */
  readonly volatileKeys: ReadonlySet<string>;
  /** Request headers whose presence is compared (lower case). */
  readonly deviceHeaders: ReadonlySet<string>;
  /** Fields that split one path into groups, when the caller passes none. */
  readonly discriminators: readonly string[];
  /**
   * Whether `request.decoded` holds the caller's fields for every request (DoraLive: the plain body, a route's
   * `params_json`, a GET's own query), not only for an encrypted one (Poppo: the decrypted `_random` / `_sign`).
   */
  readonly fieldsFromDecoded: boolean;
}

export const POPPO_WIRE: WirePolicy = {
  globalKeys: new Set([
    "p",
    "smei_id",
    "device_name",
    "c",
    "v",
    "yidun_id",
    "sl",
    "l",
    "mcc",
    "vs",
    "uuid",
    "_mtime",
    "_random",
    "_sign",
    "b_vpn",
    "_uid",
    "_token",
  ]),
  volatileKeys: new Set([
    "_mtime",
    "_random",
    "_sign",
    "_uid",
    "v",
    "vs",
    "sl",
    "l",
    "mcc",
    "smei_id",
    "uuid",
    "yidun_id",
    "device_name",
    "login_device_id",
  ]),
  deviceHeaders: new Set([
    "x-request-time",
    "x-request-device",
    "x-request-device-id",
    "x-request-agent",
    "x-request-imei",
    "x-device-info",
  ]),
  discriminators: ["type", "login_type", "use"],
  fieldsFromDecoded: false,
};
