const TS_RAW_RE = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function partsInZone(epochMs: number, timeZone: string): Omit<LocalParts, "millisecond"> | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter(timeZone).formatToParts(new Date(epochMs));
  } catch {
    return null;
  }

  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  const year = Number.parseInt(values.year ?? "", 10);
  const month = Number.parseInt(values.month ?? "", 10);
  const day = Number.parseInt(values.day ?? "", 10);
  const hour = Number.parseInt(values.hour ?? "", 10);
  const minute = Number.parseInt(values.minute ?? "", 10);
  const second = Number.parseInt(values.second ?? "", 10);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }

  return { year, month, day, hour, minute, second };
}

function timeZoneOffsetMs(epochMs: number, timeZone: string): number | null {
  const parts = partsInZone(epochMs, timeZone);
  if (parts === null) return null;
  const localAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    epochMs % 1000,
  );
  return localAsUtcMs - epochMs;
}

function localPartsToEpochMs(parts: LocalParts, timeZone: string): number | null {
  const utcGuessMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );

  const firstOffset = timeZoneOffsetMs(utcGuessMs, timeZone);
  if (firstOffset === null) return null;
  let epochMs = utcGuessMs - firstOffset;

  const secondOffset = timeZoneOffsetMs(epochMs, timeZone);
  if (secondOffset === null) return null;
  epochMs = utcGuessMs - secondOffset;

  const actual = partsInZone(epochMs, timeZone);
  if (actual === null) return null;
  if (
    actual.year !== parts.year ||
    actual.month !== parts.month ||
    actual.day !== parts.day ||
    actual.hour !== parts.hour ||
    actual.minute !== parts.minute ||
    actual.second !== parts.second ||
    epochMs % 1000 !== parts.millisecond
  ) {
    return null;
  }

  return epochMs;
}

function parseTsRaw(tsRaw: string): Omit<LocalParts, "year"> | null {
  const m = TS_RAW_RE.exec(tsRaw);
  if (m === null) return null;

  const month = Number.parseInt(m[1] as string, 10);
  const day = Number.parseInt(m[2] as string, 10);
  const hour = Number.parseInt(m[3] as string, 10);
  const minute = Number.parseInt(m[4] as string, 10);
  const second = Number.parseInt(m[5] as string, 10);
  const millisecond = Number.parseInt(m[6] as string, 10);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  if (second < 0 || second > 59) return null;

  return { month, day, hour, minute, second, millisecond };
}

export function logcatTsToEpochMs(
  tsRaw: string,
  sessionStartMs: number,
  deviceTimezone: string,
): number | null {
  const parsed = parseTsRaw(tsRaw);
  if (parsed === null) return null;

  const sessionParts = partsInZone(sessionStartMs, deviceTimezone);
  if (sessionParts === null) return null;

  const years = [sessionParts.year - 1, sessionParts.year, sessionParts.year + 1];
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const year of years) {
    const epochMs = localPartsToEpochMs({ year, ...parsed }, deviceTimezone);
    if (epochMs === null) continue;
    const distance = Math.abs(epochMs - sessionStartMs);
    if (distance < bestDistance) {
      best = epochMs;
      bestDistance = distance;
    }
  }

  return best;
}
