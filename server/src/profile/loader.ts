import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ToolDomainError } from "../mcp/toolError.ts";
import { builtinProfileNames, findBuiltinProfile } from "./registry.ts";
import { type Profile, type ProfileJson, ProfileJsonSchema } from "./types.ts";

/**
 * profile.json discovery + load + resolve to a built-in profile (v2-G Q2 + Q10 + Q11).
 *
 * Failure semantics (Q11c):
 *   - `projectRoot === null`           → return null (vanilla session, no profile)
 *   - file does not exist              → return null (vanilla session)
 *   - file unreadable / I/O failure    → throw `profile_malformed`
 *   - JSON parse fail                  → throw `profile_malformed`
 *   - zod schema fail (`.strict()`)    → throw `profile_malformed`
 *   - name not in built-in registry    → throw `profile_unknown`
 *
 * The hard-error path runs inside `start_session`; failure aborts session
 * creation so the run folder is never materialized with a half-resolved
 * profile. Vanilla / soft cases let `start_session` continue with
 * `metadata.profile === null`; `search_evidence` then soft-empties with a
 * warning per Q11b.
 */

export const PROFILE_DIR = ".android-debug-mcp";
export const PROFILE_FILENAME = "profile.json";

/** The resolved profile plus the on-disk evidence of where it came from. */
export interface LoadedProfile {
  readonly profile: Profile;
  /** Verbatim parsed contents of profile.json — written to `metadata.profile`. */
  readonly json: ProfileJson;
  /** Absolute path to the loaded profile.json. */
  readonly path: string;
}

export async function loadProfile(projectRoot: string | null): Promise<LoadedProfile | null> {
  if (projectRoot === null) return null;
  const path = join(projectRoot, PROFILE_DIR, PROFILE_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw new ToolDomainError(
      "profile_malformed",
      `failed to read profile.json at ${path}: ${describe(err)}`,
      { path },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ToolDomainError(
      "profile_malformed",
      `profile.json at ${path} is not valid JSON: ${describe(err)}`,
      { path },
    );
  }

  let json: ProfileJson;
  try {
    json = ProfileJsonSchema.parse(raw);
  } catch (err) {
    const detail =
      err instanceof z.ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : describe(err);
    throw new ToolDomainError(
      "profile_malformed",
      `profile.json at ${path} failed validation: ${detail}`,
      { path },
    );
  }

  const profile = findBuiltinProfile(json.name);
  if (profile === null) {
    throw new ToolDomainError(
      "profile_unknown",
      `profile.json at ${path} names "${json.name}", which is not in the built-in registry.`,
      { path, name: json.name, known: builtinProfileNames() },
    );
  }

  return { profile, json, path };
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
