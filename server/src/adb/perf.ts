import { runAdb } from "./adb.ts";

export interface GfxInfoDigest {
  readonly totalFrames: number | null;
  readonly jankyFrames: number | null;
  readonly jankyPercent: number | null;
  readonly percentilesMs: {
    readonly p50?: number;
    readonly p90?: number;
    readonly p95?: number;
    readonly p99?: number;
  };
}

export interface MemInfoDigest {
  readonly totalPssKb: number | null;
  readonly nativeHeapKb: number | null;
  readonly dalvikHeapKb: number | null;
  readonly graphicsKb: number | null;
  readonly stackKb: number | null;
  readonly codeKb: number | null;
}

export interface ParsedPerf<T> {
  readonly digest: T;
  readonly warnings: readonly string[];
}

export interface CollectedPerf<T> extends ParsedPerf<T> {
  readonly raw: string;
}

const PERCENTILE_KEYS: Record<string, keyof GfxInfoDigest["percentilesMs"]> = {
  "50": "p50",
  "90": "p90",
  "95": "p95",
  "99": "p99",
};

export async function collectGfxInfo(
  deviceSerial: string,
  packageName: string,
): Promise<CollectedPerf<GfxInfoDigest>> {
  const res = await runAdb(["-s", deviceSerial, "shell", "dumpsys", "gfxinfo", packageName], {
    timeoutMs: 12_000,
  });
  return { ...parseGfxInfo(res.stdout), raw: res.stdout };
}

export async function resetGfxInfo(deviceSerial: string, packageName: string): Promise<void> {
  await runAdb(["-s", deviceSerial, "shell", "dumpsys", "gfxinfo", packageName, "reset"], {
    timeoutMs: 12_000,
  });
}

export async function collectMemInfo(
  deviceSerial: string,
  packageName: string,
): Promise<CollectedPerf<MemInfoDigest>> {
  const res = await runAdb(["-s", deviceSerial, "shell", "dumpsys", "meminfo", packageName], {
    timeoutMs: 12_000,
  });
  return { ...parseMemInfo(res.stdout), raw: res.stdout };
}

export function parseGfxInfo(stdout: string): ParsedPerf<GfxInfoDigest> {
  const totalFrames = parseIntMatch(stdout, /^\s*Total frames rendered:\s*([\d,]+)/im);
  const janky = /^\s*Janky frames:\s*([\d,]+)(?:\s*\(([\d.]+)%\))?/im.exec(stdout);
  const jankyFrames = janky?.[1] ? parseNumber(janky[1]) : null;
  const jankyPercent = janky?.[2] ? parseNumber(janky[2]) : null;
  const percentilesMs: {
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  } = {};

  for (const match of stdout.matchAll(/^\s*(50|90|95|99)th percentile:\s*([\d.]+)ms/gim)) {
    const key = PERCENTILE_KEYS[match[1] as keyof typeof PERCENTILE_KEYS];
    const value = match[2] ? parseNumber(match[2]) : null;
    if (key !== undefined && value !== null) percentilesMs[key] = value;
  }

  const digest = { totalFrames, jankyFrames, jankyPercent, percentilesMs };
  const warnings =
    totalFrames === null && jankyFrames === null && Object.keys(percentilesMs).length === 0
      ? ["gfxinfo output did not contain recognized frame counters"]
      : [];
  return { digest, warnings };
}

export function parseMemInfo(stdout: string): ParsedPerf<MemInfoDigest> {
  const digest: MemInfoDigest = {
    totalPssKb: parseTotalPss(stdout),
    nativeHeapKb: parseMemRow(stdout, "Native Heap"),
    dalvikHeapKb: parseMemRow(stdout, "Dalvik Heap"),
    graphicsKb: parseMemRow(stdout, "Graphics"),
    stackKb: parseMemRow(stdout, "Stack"),
    codeKb: parseMemRow(stdout, "Code"),
  };
  const warnings = Object.values(digest).every((v) => v === null)
    ? ["meminfo output did not contain recognized PSS rows"]
    : [];
  return { digest, warnings };
}

function parseTotalPss(stdout: string): number | null {
  return (
    parseIntMatch(stdout, /^\s*TOTAL\s+PSS:\s*([\d,]+)/im) ??
    parseIntMatch(stdout, /^\s*TOTAL:\s*([\d,]+)/im) ??
    parseIntMatch(stdout, /^\s*TOTAL\s+([\d,]+)/im)
  );
}

function parseMemRow(stdout: string, label: string): number | null {
  const escaped = label.replaceAll(" ", "\\s+");
  return parseIntMatch(stdout, new RegExp(`^\\s*${escaped}\\s+([\\d,]+)`, "im"));
}

function parseIntMatch(stdout: string, re: RegExp): number | null {
  const raw = re.exec(stdout)?.[1];
  if (raw === undefined) return null;
  const parsed = parseNumber(raw);
  return parsed === null ? null : Math.trunc(parsed);
}

function parseNumber(raw: string): number | null {
  const parsed = Number.parseFloat(raw.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}
