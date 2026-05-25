import { POPPO_VONE_PROFILE } from "./poppo-vone/index.ts";
import type { Profile } from "./types.ts";

/**
 * Built-in profile registry. Profile DEFINITIONS live in `server/src/profile/<name>/`;
 * `profile.json` only carries the `name` to select among these.
 *
 * v2-G MVP ships exactly one built-in profile: `poppo-vone`. Future profiles
 * (Compose-flavored Poppo, partner apps, popposhell) are added by dropping a
 * new module here. The lookup is hermetic — no dynamic import, no
 * user-provided TS — so adding a profile is intentional code-level surface
 * change (codex round-1 take b: "JSON-first + built-in named adapters; don't
 * default projectRoot TS dynamic import").
 */
const BUILTIN_PROFILES: ReadonlyMap<string, Profile> = new Map([
  ["poppo-vone", POPPO_VONE_PROFILE],
]);

export function findBuiltinProfile(name: string): Profile | null {
  return BUILTIN_PROFILES.get(name) ?? null;
}

export function builtinProfileNames(): readonly string[] {
  return [...BUILTIN_PROFILES.keys()];
}
