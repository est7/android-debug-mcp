import { describe, expect, it } from "vitest";
import type { SourceCandidate, SourceCandidateKind } from "../../src/source/candidate.ts";
import {
  type ConfidenceInput,
  type NodeView,
  evaluateConfidence,
} from "../../src/source/confidence.ts";

const SESSION_PKG = "com.baitu.poppo";
const LOGIN_LAYOUT = "app/src/main/res/layout/activity_login.xml";
const OTHER_LAYOUT = "app/src/main/res/layout/activity_other.xml";
const LOGIN_OWNER = "app/src/main/java/com/baitu/poppo/LoginActivity.kt";
const OTHER_OWNER = "app/src/main/java/com/baitu/poppo/OtherActivity.kt";

function node(resourceId: string | null, cls = "android.widget.Button"): NodeView {
  return { resourceId, class: cls };
}

function cand(kind: SourceCandidateKind, file: string, line = 1): SourceCandidate {
  return { kind, file, line, text: `<${kind} ${file}>` };
}

function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    candidates: [],
    anchorNode: node("com.baitu.poppo:id/login_button"),
    foregroundActivity: null,
    ancestorChain: [],
    sessionPackage: SESSION_PKG,
    ...overrides,
  };
}

describe("evaluateConfidence — none tier", () => {
  it("is none when no anchor node is provided", () => {
    const r = evaluateConfidence(input({ anchorNode: null }));
    expect(r.confidence).toBe("none");
    expect(r.signals).not.toContain("resource_id_present");
  });

  it("is none for a framework resource-id, flagged framework_resource_id", () => {
    const r = evaluateConfidence(input({ anchorNode: node("android:id/text1") }));
    expect(r.confidence).toBe("none");
    expect(r.signals).toContain("resource_id_present");
    expect(r.signals).toContain("framework_resource_id");
    expect(r.signals).not.toContain("resource_package_matches_session");
    expect(r.reason).toContain("framework");
  });

  it("is none when the anchor's resource-id belongs to a foreign package", () => {
    const r = evaluateConfidence(input({ anchorNode: node("com.other.app:id/login_button") }));
    expect(r.confidence).toBe("none");
    expect(r.signals).not.toContain("resource_package_matches_session");
    expect(r.signals).not.toContain("framework_resource_id");
  });

  it("is none when rg found nothing (zero candidates) despite a valid anchor", () => {
    const r = evaluateConfidence(input({ candidates: [] }));
    expect(r.confidence).toBe("none");
    expect(r.signals).toContain("resource_package_matches_session");
  });
});

describe("evaluateConfidence — high tier", () => {
  it("is high for a uniquely-declared id with a code reference in its screen owner", () => {
    const r = evaluateConfidence(
      input({
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("code_ref", LOGIN_OWNER, 42),
        ],
      }),
    );
    expect(r.confidence).toBe("high");
    expect(r.signals).toEqual([
      "resource_id_present",
      "resource_package_matches_session",
      "layout_declares_id",
      "code_refs_found",
    ]);
  });

  it("is high when the foreground Activity disambiguates multiple declarations", () => {
    const r = evaluateConfidence(
      input({
        foregroundActivity: "com.baitu.poppo/.LoginActivity",
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("id_declaration", OTHER_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("screen_owner", OTHER_OWNER),
          cand("code_ref", LOGIN_OWNER, 42),
        ],
      }),
    );
    expect(r.confidence).toBe("high");
    expect(r.signals).toContain("layout_inflated_by_foreground_activity");
    expect(r.signals).not.toContain("owner_ambiguous");
  });
});

describe("evaluateConfidence — medium tier", () => {
  it("is medium when an owner resolves but has no direct code reference", () => {
    const r = evaluateConfidence(
      input({
        candidates: [cand("id_declaration", LOGIN_LAYOUT), cand("screen_owner", LOGIN_OWNER)],
      }),
    );
    expect(r.confidence).toBe("medium");
    expect(r.signals).not.toContain("code_refs_found");
  });
});

describe("evaluateConfidence — low tier", () => {
  it("is low when multiple declarations cannot be disambiguated (owner_ambiguous)", () => {
    const r = evaluateConfidence(
      input({
        foregroundActivity: null,
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("id_declaration", OTHER_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("screen_owner", OTHER_OWNER),
          cand("code_ref", LOGIN_OWNER, 42),
        ],
      }),
    );
    expect(r.confidence).toBe("low");
    expect(r.signals).toContain("owner_ambiguous");
  });

  it("caps to low when the tapped node sits inside a RecyclerView, even with clean evidence", () => {
    const r = evaluateConfidence(
      input({
        ancestorChain: [
          node(null, "android.widget.FrameLayout"),
          node(null, "androidx.recyclerview.widget.RecyclerView"),
        ],
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("code_ref", LOGIN_OWNER, 42),
        ],
      }),
    );
    expect(r.confidence).toBe("low");
    expect(r.signals).toContain("recycled_row_id");
  });

  it("is low when the id is found but no screen owner ties to it", () => {
    const r = evaluateConfidence(input({ candidates: [cand("id_declaration", LOGIN_LAYOUT)] }));
    expect(r.confidence).toBe("low");
    expect(r.signals).toEqual([
      "resource_id_present",
      "resource_package_matches_session",
      "layout_declares_id",
    ]);
  });
});

describe("evaluateConfidence — signal mechanics", () => {
  it("does not count a generated_noise match as a real code reference", () => {
    const r = evaluateConfidence(
      input({
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("generated_noise", "app/src/generated/Stub.kt", 9),
        ],
      }),
    );
    expect(r.signals).not.toContain("code_refs_found");
    expect(r.confidence).toBe("medium"); // owner resolved, no real handler
  });

  it("emits signals in CONFIDENCE_SIGNALS declared order", () => {
    const r = evaluateConfidence(
      input({
        foregroundActivity: "com.baitu.poppo/com.baitu.poppo.LoginActivity",
        candidates: [
          cand("id_declaration", LOGIN_LAYOUT),
          cand("screen_owner", LOGIN_OWNER),
          cand("code_ref", LOGIN_OWNER, 42),
        ],
      }),
    );
    const sorted = [...r.signals].sort();
    // Already in declared order ⇒ equals neither a re-sorted copy nor reversed by accident.
    expect(r.signals).toEqual([
      "resource_id_present",
      "resource_package_matches_session",
      "layout_declares_id",
      "layout_inflated_by_foreground_activity",
      "code_refs_found",
    ]);
    expect(r.signals).not.toEqual(sorted.reverse());
  });
});
