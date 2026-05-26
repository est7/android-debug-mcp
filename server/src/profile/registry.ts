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
const BUILTIN_PROFILES: Map<string, Profile> = new Map([["poppo-vone", POPPO_VONE_PROFILE]]);

const TEST_PROFILES: Map<string, Profile> = new Map();

export function findBuiltinProfile(name: string): Profile | null {
  return TEST_PROFILES.get(name) ?? BUILTIN_PROFILES.get(name) ?? null;
}

export function builtinProfileNames(): readonly string[] {
  return [...TEST_PROFILES.keys(), ...BUILTIN_PROFILES.keys()];
}

/**
 * Test seam — register / unregister an additional profile by name. NOT exposed
 * via the public surface (no re-export from `index.ts`); test files import this
 * directly via `profile/registry.ts`. The TEST registry takes precedence over
 * `BUILTIN_PROFILES` on collision so a test can override `poppo-vone` if it
 * ever needs to.
 *
 * Vitest+TS module-cache isolation issues with `vi.mock` (per-file factory
 * leaking across the worker thread under `pool: 'threads'`) are why this
 * exists: a real, mutable registry is more reliable than a mocked module.
 * Always pair with {@link unregisterTestProfile} in `afterEach`.
 */
export function registerTestProfile(profile: Profile): void {
  TEST_PROFILES.set(profile.name, profile);
}

export function unregisterTestProfile(name: string): void {
  TEST_PROFILES.delete(name);
}
