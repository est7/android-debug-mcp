# Manual test plan — the five acceptance scenarios

The five scenarios from [`design-lock-v1.md`](./design-lock-v1.md), as a manual
device checklist. Automated coverage lives in `server/tests/` (`bun run test`);
this plan is the on-device acceptance pass — run it before tagging a release.

## Prerequisites

- `bun run test` is green.
- A device in `adb devices` state `device`.
- The MCP server wired into a host per the [README](../README.md), with
  `ANDROID_DEBUG_MCP_RUN_ROOT` set to a scratch directory.
- A target app installed (`com.android.settings` works for A / D / E; for B,
  any app you can crash — e.g. `adb shell am crash <package>`).
- ADBKeyBoard installed on the device (scenario C).

For each scenario: run the steps, then tick every box. A box that cannot be
ticked is a release blocker — file it.

---

## Scenario A — Happy path

**Goal:** a clean run is collected and summarised.

1. `android_debug_start_session { packageName, launchOnStart: true }`
2. `android_debug_mark_event { runId, name: "checkpoint" }`
3. Drive the app briefly (any tool, or just wait for logcat to flow).
4. `android_debug_stop_session { runId }`
5. `android_debug_get_run_summary { runId }`

- [ ] `start_session` returns a `runId` and a `runDir` that exists on disk.
- [ ] The run folder contains `metadata.json`, `events.jsonl`, `logcat.jsonl`,
      `logcat.raw.txt`, `summary.md`.
- [ ] `get_run_summary` reports device model / API, app version, git sha, and
      a counts line.
- [ ] The Markdown timeline lists the `checkpoint` mark.
- [ ] `stop_session` returns `status: "stopped"`.

## Scenario B — Crash

**Goal:** a crash is detected and its context extracted.

1. `android_debug_start_session { packageName, launchOnStart: true }`
2. Reproduce a crash (e.g. `adb shell am crash <package>`), wait a few seconds.
3. `android_debug_extract_crash_context { runId, beforeLines: 30, afterLines: 60 }`
4. `android_debug_stop_session { runId }`
5. `android_debug_get_run_summary { runId }`

- [ ] `crash.jsonl` in the run folder has at least one marker line.
- [ ] `extract_crash_context` returns `crashCount ≥ 1`, a `type`, a non-empty
      `snippet`, and a `mainException` / `topFrame` where the dump allows.
- [ ] `get_run_summary` shows the crash in its Crashes section and
      `crashFound: true`.
- [ ] A run with no crash returns `{ crashCount: 0 }` — not an error.

## Scenario C — Interaction

**Goal:** screen interaction works and sensitive input is redacted.

1. `android_debug_start_session { packageName, launchOnStart: true }`
2. Open a screen with a text field.
3. `android_debug_tap { runId, x, y, label: "field" }`
4. `android_debug_input_text { runId, text: "<a secret>", sensitive: true }`
5. `android_debug_input_text { runId, text: "中文 + emoji 😀" }`
6. `android_debug_capture { runId, kinds: ["screenshot", "ui_dump"] }`
7. `android_debug_send_key { runId, key: "BACK" }`

- [ ] Each `tap` / `input_text` / `send_key` / `swipe` adds one line to
      `events.jsonl`.
- [ ] The CJK + emoji text appears verbatim in the on-device field.
- [ ] The `sensitive` text is **not** present anywhere in `events.jsonl` or
      `commands.jsonl` — only a `***<len>` placeholder.
- [ ] `capture` writes a valid PNG and an XML dump under `artifacts/`, and
      returns a `uiSummary`.

## Scenario D — Disconnect path

**Goal:** a dropped device degrades the session cleanly.

1. `android_debug_start_session { packageName, launchOnStart: true }`
2. Disconnect the device — unplug USB, or `adb disconnect <serial>`.
3. Wait ~5s for the health poll, then `android_debug_tap { runId, x: 1, y: 1 }`.
4. `android_debug_search_logs { runId }`
5. `android_debug_stop_session { runId }`, then `android_debug_get_run_summary { runId }`.
6. Reconnect the device (`adb connect` / re-plug).

- [ ] After the poll, `tap` returns `{ isError: true, error: "device_disconnected" }`.
- [ ] `get_app_state` likewise returns `device_disconnected`.
- [ ] `search_logs` (a record-reading tool) still succeeds.
- [ ] `stop_session` finalizes, and `get_run_summary` reports `status: "degraded"`.

## Scenario E — Orphan recovery

**Goal:** a run orphaned by a hard kill is recovered on the next boot.

1. `android_debug_start_session { packageName, launchOnStart: true }`
2. `kill -9` the MCP server process (its run is now unfinalized — `closedAt` null).
3. Restart the MCP server (the host reconnects).
4. `android_debug_list_runs {}`

- [ ] On boot, the server log shows `orphan recovered` for the killed run.
- [ ] `list_runs` shows that run with `status: "aborted"` and a non-null `closedAt`.
- [ ] `get_run_summary { runId }` of the recovered run renders a (partial) report.
- [ ] The tuple's stale lockfile under `~/.android-debug-mcp/locks/` is gone.
