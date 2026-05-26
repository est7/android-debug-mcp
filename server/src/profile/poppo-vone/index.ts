import type { Profile } from "../types.ts";
import { poppoHttpSource } from "./poppo_http/source.ts";

/**
 * `poppo-vone` profile —— v2-G's first reference profile.
 *
 * Phase 4 lands the `poppo_http` `EvidenceSource` that reads `http_*.jsonl`
 * from `/sdcard/Android/data/<ctx.packageName>/files/http-logs/` per
 * [`submodulepoppo/docs/projects/http-log-jsonl-schema.md`](../../../../../submodulepoppo/docs/projects/http-log-jsonl-schema.md)
 * rev4. The per-package path comes from `EvidenceContext.packageName`, so
 * the single source impl serves both Poppo (`com.baitu.poppo`) and Vone
 * (`com.baitu.vone`) — they ship the same `CustomHttpLoggingInterceptor`.
 *
 * Out of scope for v2-G MVP (deferred to v2-H per backlog "v2-G ⭐ NEXT
 * MILESTONE"): the `source/recipe.ts` Poppo-baked source-mapping recipe
 * does NOT live here. v2-A `tap_node` / `map_ui_node_to_source` continue
 * to use the existing hardcoded recipe until v2-H extracts a
 * `SourceProfile` interface.
 */
export const POPPO_VONE_PROFILE: Profile = {
  name: "poppo-vone",
  evidenceSources: [poppoHttpSource],
};
