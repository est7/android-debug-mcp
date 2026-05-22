import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceCandidate, SourceCandidateKind } from "../../src/source/candidate.ts";
import {
  parseResourceId,
  resolveCandidates,
  toBindingClassName,
  toLowerCamelCase,
} from "../../src/source/recipe.ts";
import { materializeSourceFixture } from "../fixtures/source/build_fixture.ts";

/** `resolveCandidates` now returns `{candidates, commands}`; tests assert on the candidates. */
async function candidatesOf(resourceId: string, root: string): Promise<SourceCandidate[]> {
  return (await resolveCandidates(resourceId, root)).candidates;
}

describe("parseResourceId", () => {
  it("splits a well-formed app resource-id into pkg + entry", () => {
    expect(parseResourceId("com.baitu.poppo:id/login_button")).toEqual({
      pkg: "com.baitu.poppo",
      entry: "login_button",
    });
  });

  it("parses a framework resource-id (the recipe leaves the framework policy to the caller)", () => {
    expect(parseResourceId("android:id/text1")).toEqual({ pkg: "android", entry: "text1" });
  });

  it("returns null for a string that is not <pkg>:id/<entry>", () => {
    expect(parseResourceId("not-a-resource-id")).toBeNull();
    expect(parseResourceId("com.x:id/")).toBeNull();
    expect(parseResourceId("com.x:layout/main")).toBeNull();
  });
});

describe("toLowerCamelCase", () => {
  it("converts snake_case ids to lowerCamelCase", () => {
    expect(toLowerCamelCase("face_mask_top")).toBe("faceMaskTop");
    expect(toLowerCamelCase("iv_photo")).toBe("ivPhoto");
  });

  it("leaves an already-camel id unchanged", () => {
    expect(toLowerCamelCase("loginButton")).toBe("loginButton");
  });
});

describe("toBindingClassName", () => {
  it("derives the ViewBinding class name from a layout file base name", () => {
    expect(toBindingClassName("activity_homepage_3")).toBe("ActivityHomepage3Binding");
    expect(toBindingClassName("fragment_profile")).toBe("FragmentProfileBinding");
  });
});

describe("resolveCandidates — ViewBinding rg recipe", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "android-debug-mcp-recipe-"));
    materializeSourceFixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function kindsOf(candidates: readonly SourceCandidate[]): SourceCandidateKind[] {
    return candidates.map((c) => c.kind);
  }

  it("resolves id_declaration, screen_owner and code_ref for a tapped id", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/login_button", root);
    // Deterministic order: id_declaration, screen_owner, code_ref, generated_noise.
    expect(kindsOf(candidates)).toEqual([
      "id_declaration",
      "screen_owner",
      "code_ref",
      "generated_noise",
    ]);
    const byKind = (k: SourceCandidateKind) => candidates.find((c) => c.kind === k);
    expect(byKind("id_declaration")?.file).toBe("app/src/main/res/layout/activity_login.xml");
    expect(byKind("screen_owner")?.file).toBe(
      "app/src/main/java/com/example/poppo/LoginActivity.kt",
    );
    expect(byKind("code_ref")?.file).toBe("app/src/main/java/com/example/poppo/LoginActivity.kt");
  });

  it("matches the id declaration on a word boundary — login_button_extra is not a hit", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/login_button", root);
    const decls = candidates.filter((c) => c.kind === "id_declaration");
    expect(decls).toHaveLength(1);
    expect(decls[0]?.text).toContain("@+id/login_button");
    expect(decls[0]?.text).not.toContain("login_button_extra");
  });

  it("excludes generated output under build/ entirely", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/login_button", root);
    expect(candidates.every((c) => !c.file.includes("/build/"))).toBe(true);
  });

  it("flags a match from a non-build `generated` path as generated_noise", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/login_button", root);
    const noise = candidates.filter((c) => c.kind === "generated_noise");
    expect(noise).toHaveLength(1);
    expect(noise[0]?.file).toBe("app/src/generated/com/example/poppo/StubGenerated.kt");
  });

  it("converts a snake_case id to the camelCase binding reference (face_mask_top)", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/face_mask_top", root);
    const codeRef = candidates.find((c) => c.kind === "code_ref");
    expect(codeRef?.text).toContain("binding.faceMaskTop");
  });

  it("resolves a Fragment screen owner via BaseBindingFragment<XxxBinding>", async () => {
    const candidates = await candidatesOf("com.example.poppo:id/profile_avatar", root);
    const owner = candidates.find((c) => c.kind === "screen_owner");
    expect(owner?.file).toBe("app/src/main/java/com/example/poppo/ProfileFragment.kt");
    expect(owner?.text).toContain("BaseBindingFragment<FragmentProfileBinding>");
  });

  it("returns no candidates for an id that is declared and referenced nowhere", async () => {
    expect(await candidatesOf("com.example.poppo:id/nonexistent_id", root)).toEqual([]);
  });

  it("returns no candidates (and runs no search) for a malformed resource-id", async () => {
    expect(await candidatesOf("garbage", root)).toEqual([]);
  });

  it("reports the literal rg commands it ran (for the commands.jsonl audit trail)", async () => {
    const { commands } = await resolveCandidates("com.example.poppo:id/login_button", root);
    expect(commands.length).toBeGreaterThanOrEqual(2); // id_declaration + code_ref searches
    expect(commands.every((c) => c.startsWith("rg "))).toBe(true);
    expect(commands.some((c) => c.includes("@\\+id/login_button"))).toBe(true);
  });
});
