import type { RunData } from "./collect.ts";

/**
 * Most timeline entries shown in the rendered summary. A long run can record
 * thousands of events; the markdown stays bounded by keeping the most recent
 * {@link TIMELINE_CAP} and noting how many were elided.
 */
const TIMELINE_CAP = 200;

/**
 * Render a run's evidence as a Markdown report — pure, no IO. The output is the
 * `content[0].text` of `get_run_summary` and the body of `summary.md`.
 */
export function renderSummary(data: RunData): string {
  const m = data.metadata;
  const out: string[] = [];

  out.push(`# Run Summary — ${m.packageName}`, "");
  out.push(`- **Run ID:** ${m.runId}`);
  out.push(`- **Status:** ${m.status}${m.crashFound ? " · crash detected" : ""}`);
  out.push(
    `- **Device:** ${m.device.model ?? "?"} (${m.deviceSerial}) · API ${m.device.apiLevel ?? "?"} · ${m.device.abi ?? "?"}`,
  );
  out.push(`- **App:** ${m.app.versionName ?? "?"} (build ${m.app.versionCode ?? "?"})`);
  out.push(`- **Git:** ${m.git.sha ?? "?"}${m.git.dirty === true ? " (dirty)" : ""}`);
  out.push(`- **User:** u${m.userId}`);
  out.push(`- **Started:** ${m.startedAt}`);
  out.push(`- **Closed:** ${m.closedAt ?? "— (still active)"}`);
  out.push("");

  out.push("## Counts", "");
  out.push(
    `- Events ${data.counts.events} · Commands ${data.counts.commands} · ` +
      `Logcat lines ${data.counts.logcatLines} · Crashes ${data.counts.crashes}`,
  );
  out.push("");

  out.push("## Crashes", "");
  if (data.crashes.length === 0) {
    out.push("No crashes detected.");
  } else {
    for (const c of data.crashes) {
      out.push(`- **${c.type}** — raw line ${c.rawLineNo} — \`${c.marker}\``);
    }
  }
  out.push("");

  out.push("## Timeline", "");
  const events = data.events;
  if (events.length === 0) {
    out.push("No events recorded.");
  } else {
    const shown = events.length > TIMELINE_CAP ? events.slice(-TIMELINE_CAP) : events;
    if (events.length > TIMELINE_CAP) {
      out.push(
        `_(${events.length - TIMELINE_CAP} earlier events omitted; latest ${TIMELINE_CAP} shown)_`,
        "",
      );
    }
    for (const e of shown) {
      out.push(`- \`${asString(e.ts) ?? "?"}\` ${describeEvent(e)}`);
    }
  }

  return `${out.join("\n")}\n`;
}

function describeEvent(e: Record<string, unknown>): string {
  const type = asString(e.type) ?? "event";
  switch (type) {
    case "mark":
      return `mark "${asString(e.name) ?? "?"}"`;
    case "lifecycle":
      return `lifecycle: ${asString(e.phase) ?? "?"}`;
    case "tap": {
      const label = asString(e.label);
      return `tap (${asNumber(e.x)}, ${asNumber(e.y)})${label ? ` — ${label}` : ""}`;
    }
    case "input_text":
      return `input_text — ${asNumber(e.length)} chars${e.redacted === true ? " (redacted)" : ""}`;
    case "send_key":
      return `send_key ${asString(e.key) ?? "?"}`;
    case "swipe":
      return `swipe (${asNumber(e.x1)}, ${asNumber(e.y1)}) → (${asNumber(e.x2)}, ${asNumber(e.y2)})`;
    case "capture":
      return `capture ${Array.isArray(e.kinds) ? e.kinds.join("+") : "?"}`;
    case "tap_node": {
      const label = asString(e.label);
      const anchor = anchorResourceId(e.anchorNode);
      return `tap_node (${asNumber(e.x)}, ${asNumber(e.y)})${anchor ? ` → ${anchor}` : ""}${label ? ` — ${label}` : ""}`;
    }
    case "source_mapping": {
      const anchor = anchorResourceId(e.anchorNode) ?? "(no anchor)";
      const conf = asString(e.confidence) ?? "?";
      const n = Array.isArray(e.candidates) ? e.candidates.length : 0;
      return `source_mapping ${anchor} → ${conf} (${n} candidate${n === 1 ? "" : "s"})`;
    }
    case "auto_stopped_by_timeout":
      return `auto-stopped — ${asString(e.reason) ?? "?"}`;
    case "device_disconnected":
      return `device disconnected — ${asString(e.deviceSerial) ?? "?"}`;
    case "logd_dropped":
      return `logd dropped ${asNumber(e.count)} lines`;
    case "abnormal_long_line":
      return `abnormal long line — ${asNumber(e.length)} chars`;
    default:
      return type;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): string {
  return typeof v === "number" ? String(v) : "?";
}

/** The `resourceId` of a `tap_node` event's `anchorNode`, when present. */
function anchorResourceId(anchor: unknown): string | undefined {
  if (typeof anchor !== "object" || anchor === null) return undefined;
  const rid = (anchor as { resourceId?: unknown }).resourceId;
  return typeof rid === "string" ? rid : undefined;
}
