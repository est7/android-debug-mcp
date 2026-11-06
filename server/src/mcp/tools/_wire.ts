import { z } from "zod";
import { builtinProfileNames, findBuiltinProfile } from "../../profile/registry.ts";
import { readMetadata } from "../../store/metadata.ts";
import { POPPO_WIRE, type WirePolicy } from "../../wire/policy.ts";
import { ToolDomainError } from "../toolError.ts";

/** The wire tools' `profile` argument: a built-in profile name, for files read without a run. */
export const profileInput = z.string().min(1).max(64);

export interface ResolvedWire {
  /** The profile whose wire is used; null is the default (Poppo's), when neither the call nor the run names one. */
  readonly profile: string | null;
  readonly policy: WirePolicy;
}

/**
 * Which app's wire a snapshot or diff reads with (`wire/policy.ts`): the `profile` the call names, else the run's
 * own (from its `profile.json`), else Poppo's, which is what both tools did before profiles carried one.
 *
 * @throws ToolDomainError `invalid_argument` when the call names a profile that is not built in.
 */
export async function resolveWire(
  profile: string | undefined,
  runDir: string | undefined,
): Promise<ResolvedWire> {
  if (profile !== undefined) {
    const named = findBuiltinProfile(profile);
    if (named === null) {
      throw new ToolDomainError(
        "invalid_argument",
        `Unknown profile '${profile}'; built in: ${builtinProfileNames().join(", ")}.`,
        { profile },
      );
    }
    return { profile: named.name, policy: named.wire ?? POPPO_WIRE };
  }
  if (runDir !== undefined) {
    const name = (await readMetadata(runDir)).profile?.name;
    const own = name === undefined ? null : findBuiltinProfile(name);
    if (own !== null) return { profile: own.name, policy: own.wire ?? POPPO_WIRE };
  }
  return { profile: null, policy: POPPO_WIRE };
}
