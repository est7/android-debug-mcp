import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolDomainError } from "../mcp/toolError.ts";
import { readLinesFrom } from "./line_reader.ts";

export type CrashType = "java" | "native" | "anr";

/** One crash marker as recorded by the Phase 4 detector in `crash.jsonl`. */
export interface CrashMarker {
  readonly rawLineNo: number;
  readonly type: CrashType;
  readonly marker: string;
  readonly line: string;
}

export interface CrashContextOptions {
  readonly crashIndex: number;
  readonly beforeLines: number;
  readonly afterLines: number;
}

export interface CrashContext {
  readonly crashCount: number;
  readonly crashIndex?: number;
  readonly type?: CrashType;
  readonly marker?: string;
  readonly rawLineNo?: number;
  readonly mainException?: string | null;
  readonly topFrame?: string | null;
  readonly snippet?: string;
  readonly snippetRange?: { readonly from: number; readonly to: number };
  readonly truncated?: boolean;
  readonly truncationMessage?: string;
}

/**
 * Extract the raw-log context around a recorded crash.
 *
 * `crash.jsonl` carries `rawLineNo` — a 1-based line number in
 * `logcat.raw.txt`. The window `[rawLineNo - beforeLines, rawLineNo +
 * afterLines]` is sliced from the raw file (streamed, never fully loaded), the
 * crash signature is parsed best-effort, and the snippet is shrunk symmetrically
 * around the marker line if it would overflow `charBudget` (§ G-5).
 *
 * A run with no crash returns `{crashCount: 0}` — that is a normal outcome,
 * not an error.
 */
export async function extractCrashContext(
  runDir: string,
  opts: CrashContextOptions,
  charBudget: number,
): Promise<CrashContext> {
  const markers = await readCrashMarkers(runDir);
  if (markers.length === 0) return { crashCount: 0 };
  if (opts.crashIndex >= markers.length) {
    throw new ToolDomainError(
      "invalid_argument",
      `crashIndex ${opts.crashIndex} is out of range; this run has ${markers.length} crash(es).`,
      { crashIndex: opts.crashIndex, crashCount: markers.length },
    );
  }
  const marker = markers[opts.crashIndex] as CrashMarker;
  const window = await extractWindow(
    join(runDir, "logcat.raw.txt"),
    marker.rawLineNo,
    opts.beforeLines,
    opts.afterLines,
  );
  const { mainException, topFrame } = parseSignature(marker.type, window.lines, window.markerIndex);
  const fitted = fitWindow(window, charBudget);
  let snippet = fitted.lines.join("\n");
  let truncated = fitted.truncated;
  if (snippet.length > charBudget) {
    snippet = `${snippet.slice(0, charBudget)}…[snippet cut]`;
    truncated = true;
  }

  return {
    crashCount: markers.length,
    crashIndex: opts.crashIndex,
    type: marker.type,
    marker: marker.marker,
    rawLineNo: marker.rawLineNo,
    mainException,
    topFrame,
    snippet,
    snippetRange: { from: fitted.from, to: fitted.to },
    ...(truncated
      ? {
          truncated: true,
          truncationMessage:
            "The crash snippet exceeded the response size limit and was shrunk around the " +
            "marker line. Re-request with smaller `beforeLines` / `afterLines`, or read " +
            "logcat.raw.txt in the run folder directly.",
        }
      : {}),
  };
}

async function readCrashMarkers(runDir: string): Promise<CrashMarker[]> {
  let text: string;
  try {
    text = await readFile(join(runDir, "crash.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: CrashMarker[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof obj.rawLineNo === "number" &&
      typeof obj.line === "string" &&
      (obj.type === "java" || obj.type === "native" || obj.type === "anr")
    ) {
      out.push({
        rawLineNo: obj.rawLineNo,
        type: obj.type,
        marker: typeof obj.marker === "string" ? obj.marker : "",
        line: obj.line,
      });
    }
  }
  return out;
}

interface Window {
  readonly lines: string[];
  readonly from: number;
  readonly to: number;
  /** Index into `lines` of the crash marker line. */
  readonly markerIndex: number;
}

/** Slice `[targetLine - before, targetLine + after]` from a 1-based line-numbered file. */
async function extractWindow(
  rawPath: string,
  targetLine: number,
  before: number,
  after: number,
): Promise<Window> {
  const from = Math.max(1, targetLine - before);
  const last = targetLine + after;
  const lines: string[] = [];
  let lineNo = 0;
  for await (const { text } of readLinesFrom(rawPath)) {
    lineNo++;
    if (lineNo < from) continue;
    if (lineNo > last) break;
    lines.push(text);
  }
  const to = lines.length > 0 ? from + lines.length - 1 : from;
  const markerIndex = Math.min(Math.max(0, targetLine - from), Math.max(0, lines.length - 1));
  return { lines, from, to, markerIndex };
}

interface FittedWindow {
  readonly lines: string[];
  readonly from: number;
  readonly to: number;
  readonly truncated: boolean;
}

/** Shrink the window symmetrically around the marker line until it fits the budget. */
function fitWindow(window: Window, charBudget: number): FittedWindow {
  let lo = 0;
  let hi = window.lines.length - 1;
  const sizeOf = (): number => window.lines.slice(lo, hi + 1).join("\n").length;
  let dropFront = true;
  while (sizeOf() > charBudget && (lo < window.markerIndex || hi > window.markerIndex)) {
    if (dropFront && lo < window.markerIndex) lo++;
    else if (hi > window.markerIndex) hi--;
    else lo++;
    dropFront = !dropFront;
  }
  return {
    lines: window.lines.slice(lo, hi + 1),
    from: window.from + lo,
    to: window.from + hi,
    truncated: lo > 0 || hi < window.lines.length - 1,
  };
}

const JAVA_EXCEPTION = /((?:[\w$]+\.)*[\w$]*(?:Exception|Error|Throwable)\b.*)$/;
const STACK_FRAME = /(\bat\s+[\w$<>]+(?:\.[\w$<>]+)*\(.*\))/;
const NATIVE_SIGNAL = /(signal\s+\d+\s*\(SIG[^)]*\)[^\n]*)/i;
const NATIVE_FRAME = /(#0[0-9]?\s+pc\s+.*)$/;
const ANR_REASON = /(ANR in\s+.*)$/i;

/**
 * Best-effort parse of the crash's headline + first frame from the window.
 * Both fields are nullable — a malformed or unusual dump simply yields null.
 */
function parseSignature(
  type: CrashType,
  lines: readonly string[],
  markerIndex: number,
): { mainException: string | null; topFrame: string | null } {
  const fromMarker = lines.slice(Math.max(0, markerIndex));
  let mainException: string | null = null;
  let topFrame: string | null = null;
  for (const line of fromMarker) {
    if (mainException === null) {
      if (type === "java" && !STACK_FRAME.test(line)) {
        mainException = JAVA_EXCEPTION.exec(line)?.[1]?.trim() ?? null;
      } else if (type === "native") {
        mainException = NATIVE_SIGNAL.exec(line)?.[1]?.trim() ?? null;
      } else if (type === "anr") {
        mainException = ANR_REASON.exec(line)?.[1]?.trim() ?? null;
      }
    }
    if (topFrame === null) {
      const frameRe = type === "native" ? NATIVE_FRAME : STACK_FRAME;
      topFrame = frameRe.exec(line)?.[1]?.trim() ?? null;
    }
    if (mainException !== null && topFrame !== null) break;
  }
  return { mainException, topFrame };
}
