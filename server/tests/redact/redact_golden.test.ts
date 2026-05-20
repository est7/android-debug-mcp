import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactInputText, redactValue } from "../../src/redact/redact.ts";

/**
 * Golden regression for the redactor. The cases live as JSON fixtures so a
 * change in `redactValue` / `redactInputText` output is caught as a concrete
 * diff against a recorded expectation — complementing the behavior-by-behavior
 * unit cases in `redact.test.ts`.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "redact");

interface GoldenCase {
  readonly name: string;
  readonly input: unknown;
  readonly expected: unknown;
}

function load(file: string): GoldenCase[] {
  return JSON.parse(readFileSync(join(DIR, file), "utf8")) as GoldenCase[];
}

describe("redact golden — events.jsonl / commands.jsonl records", () => {
  it.each([...load("events.json"), ...load("commands.json")])("$name", (gold) => {
    expect(redactValue(gold.input)).toEqual(gold.expected);
  });
});

describe("redact golden — input_text heuristic", () => {
  it.each(load("input-text.json"))("$name", (gold) => {
    expect(redactInputText(gold.input as string)).toEqual(gold.expected);
  });
});
