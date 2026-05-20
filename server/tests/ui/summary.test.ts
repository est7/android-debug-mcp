import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeUiXml } from "../../src/ui/summary.ts";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/ui/${name}`, import.meta.url)), "utf8");
}

describe("summarizeUiXml — real-shaped fixtures", () => {
  it("counts every node and the clickable subset for a Settings dump", () => {
    expect(summarizeUiXml(fixture("settings.xml"))).toEqual({
      nodeCount: 7,
      clickableCount: 3,
    });
  });

  it("counts a login screen with several interactive fields", () => {
    expect(summarizeUiXml(fixture("login.xml"))).toEqual({
      nodeCount: 8,
      clickableCount: 5,
    });
  });
});

describe("summarizeUiXml — edge cases", () => {
  it("an empty hierarchy reports zero", () => {
    expect(summarizeUiXml('<hierarchy rotation="0"></hierarchy>')).toEqual({
      nodeCount: 0,
      clickableCount: 0,
    });
  });

  it("a screen with no clickable nodes", () => {
    const xml =
      '<hierarchy><node class="X" clickable="false" /><node class="Y" clickable="false" /></hierarchy>';
    expect(summarizeUiXml(xml)).toEqual({ nodeCount: 2, clickableCount: 0 });
  });

  it('matches `clickable="true"` exactly — `long-clickable` is not miscounted', () => {
    const xml =
      '<hierarchy><node clickable="false" long-clickable="true" /><node clickable="true" long-clickable="false" /></hierarchy>';
    expect(summarizeUiXml(xml)).toEqual({ nodeCount: 2, clickableCount: 1 });
  });

  it("does not match a substring of a longer tag name", () => {
    // `<nodefoo>` is not a `<node>`.
    expect(summarizeUiXml("<hierarchy><nodefoo /></hierarchy>")).toEqual({
      nodeCount: 0,
      clickableCount: 0,
    });
  });
});
