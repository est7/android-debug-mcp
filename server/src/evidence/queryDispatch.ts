import type { z } from "zod";
import { ToolDomainError } from "../mcp/toolError.ts";
import type { EvidenceQuery, EvidenceSource, Profile } from "../profile/types.ts";

/**
 * Q4 discriminated-union dispatch — pure.
 *
 * The MCP tool boundary keeps `query` loose
 * (`z.object({ source: z.string() }).passthrough()`) because zod cannot
 * construct a zero-arm `discriminatedUnion` at server boot when the active
 * profile is unknown. This module is where the strict per-source validation
 * actually happens.
 *
 * Decision matrix (Q11):
 *   profile === null                              → soft_empty
 *   profile loaded, query.source not in profile   → soft_empty
 *   profile loaded, source.id matches, schema ok  → ok
 *   profile loaded, source.id matches, schema fails → malformed
 *
 * `malformed` is returned (not thrown) so callers — handlers and tests —
 * can branch deterministically. Handlers turn it into a thrown
 * {@link ToolDomainError}; tests inspect the variant.
 */

/** Looseness contract: caller (tool handler) has already ensured `.source` is a non-empty string. */
export interface LooseQuery {
  readonly source: string;
  readonly [key: string]: unknown;
}

export type QueryDispatchResult =
  | {
      readonly kind: "ok";
      readonly source: EvidenceSource;
      readonly parsedQuery: EvidenceQuery;
    }
  | {
      readonly kind: "soft_empty";
      readonly warning: string;
    }
  | {
      readonly kind: "malformed";
      readonly error: ToolDomainError;
    };

export function dispatchQuery(profile: Profile | null, query: LooseQuery): QueryDispatchResult {
  if (profile === null) {
    return {
      kind: "soft_empty",
      warning: `session has no profile loaded; source '${query.source}' has no provider`,
    };
  }

  const source = profile.evidenceSources.find((s) => s.id === query.source);
  if (source === undefined) {
    return {
      kind: "soft_empty",
      warning: `profile '${profile.name}' has no provider for source '${query.source}'`,
    };
  }

  const result = source.querySchema.safeParse(query);
  if (!result.success) {
    const detail = formatZodError(result.error);
    return {
      kind: "malformed",
      error: new ToolDomainError(
        "query_malformed",
        `query for source '${source.id}' failed validation: ${detail}`,
        { source: source.id },
      ),
    };
  }

  return {
    kind: "ok",
    source,
    parsedQuery: result.data as EvidenceQuery,
  };
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
