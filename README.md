# android-debug-mcp

> 中文文档:[readme-zh.md](./readme-zh.md)

A local **stdio MCP server** for **Android application-layer debug evidence
collection**. It gives an MCP agent a session-scoped, audited way to drive a
real device over `adb` — launch an app, reproduce a bug, interact with the
screen, and collect logcat / crashes / screenshots / explicit MP4 screen
recordings into a self-contained run folder.

It is *evidence-first*: every tool call is recorded, every run is a folder on
disk you can inspect, bundle, or hand to a teammate. It deliberately does **not**
do element-based UI automation (no AccessibilityService, no view-tree tapping) —
see [Coexisting with mobile-mcp](#coexisting-with-mobile-mcp).

Status: **main** — 25 tools registered; v1 + v2 acceptance scenarios and on-device e2e pass.

## Prerequisites

- **Bun ≥ 1.1** — the runtime (`engines.bun` in `package.json`).
- **`adb`** on `PATH` (Android platform-tools), or `ADB_PATH` pointing at the binary.
- **`ffmpeg`** on `PATH` to derive one visual-change key-frame contact sheet from a saved MP4.
  Recording still succeeds without it, with an explicit warning and an empty
  `contactSheet` result.
- An Android device (or emulator) with **USB debugging** authorized: `adb devices`
  should list it in state `device`.
- For `android_debug_input_text` only: the **ADBKeyBoard** helper APK installed
  on the device — see [Typing text](#typing-text-adbkeyboard).

## Use it — wire into an MCP host

The server speaks MCP over stdio. Your host fetches and runs it straight from
this GitHub repo via `npx` — no clone, no global install, no build step. Bun
must be on `PATH` (the server runs as TypeScript under Bun).

**Claude Code / Cursor** — add to `mcp.json` (Cursor) or `.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "android-debug": {
      "command": "npx",
      "args": ["-y", "github:est7/android-debug-mcp"]
    }
  }
}
```

Claude Code CLI equivalent:

```sh
claude mcp add android-debug -- npx -y github:est7/android-debug-mcp
```

`npx` clones and installs on first run (a few seconds), then caches it. Pin a
release with `github:est7/android-debug-mcp#v0.1.0`; omit the suffix to track
`main`. `bunx` works in place of `npx`.

### Run folder location — `ANDROID_DEBUG_MCP_RUN_ROOT` (optional)

By default the server writes run folders to `<project>/.android-debug-runs/`,
finding `<project>` from `git rev-parse --show-toplevel` of the directory your
MCP host was launched in. **Launch your host inside the Android project you are
debugging and no configuration is needed.**

Set `ANDROID_DEBUG_MCP_RUN_ROOT` only to override that default. Full
resolution order (§ C-3):

1. `start_session({ projectRoot })` argument, if given → `<projectRoot>/.android-debug-runs/`
2. `ANDROID_DEBUG_MCP_RUN_ROOT` env var → taken verbatim
3. `git rev-parse --show-toplevel` of the server's cwd → `<top>/.android-debug-runs/` *(the default)*
4. Fallback, when cwd is not in a git repo → `~/.android-debug-mcp/runs/`

To override, add an `env` block to the config above:

```json
"env": { "ANDROID_DEBUG_MCP_RUN_ROOT": "/abs/path/to/runs" }
```

A run folder is `<runRoot>/<package>/u<userId>/<runId>/` and holds
`metadata.json`, `events.jsonl`, `commands.jsonl`, `logcat.jsonl`,
`logcat.raw.txt`, `crash.jsonl`, `summary.md`, and an `artifacts/` directory.

### Run index — `ANDROID_DEBUG_MCP_INDEX_ROOT` (optional, v0.4.1+)

Each `start_session` also writes a symlink at
`~/.android-debug-mcp/run-index/<runId>` → real runDir. Evidence tools use
this index to find a run after stop, even when the lookup-time `runRoot`
resolves differently from the run-creation-time `runRoot` (e.g. a tool call
from a cwd whose git toplevel differs from the original `projectRoot`). The
index is identity-checked (`metadata.runId` must match) and a missing /
invalid entry falls back to scanning the current `runRoot`.

Set `ANDROID_DEBUG_MCP_INDEX_ROOT` only to move the index off `$HOME` — e.g.
park it on a different volume, or isolate it per-workspace. Default
(`~/.android-debug-mcp/run-index/`) is correct for almost all users.

## The 25 tools

Every tool is named `android_debug_*`. On **success** it returns
`structuredContent`. A recoverable **failure** instead returns
`{ isError: true }` with the JSON `{error, message, …}` payload in
`content[0].text` and **no** `structuredContent` — the agent branches on that
payload; it is never raised as a raw protocol error.

A session is a singleton per `(deviceSerial, userId, packageName)` tuple — one
active run per app per device. Every interaction/evidence call carries the
`runId` returned by `start_session`.

### Session lifecycle

| Tool | What it does |
|---|---|
| `start_session` | Acquire the singleton lock, materialize the run folder, capture app/device/git provenance, optionally launch. Returns the `runId` every later call carries (+ `versionName`/`versionCode`, `profileName`). |
| `stop_session` | Finalize the run: seal evidence, flush and close the jsonl streams, release the lock. |
| `get_app_state` | Live read-only snapshot: foreground activity, pids, installed version, recent `exit-info`, session health. |
| `get_run_summary` | Full Markdown report + structured metadata for a run — provenance, counts, crash list, event timeline. |
| `app_control` | Drive app lifecycle for the active session: launch / stop / force-stop / restart. |
| `clear_app_data` | `pm clear` the app — reset to first-launch state. |

### Devices & runs

| Tool | What it does |
|---|---|
| `list_devices` | List adb-visible devices (incl. offline / unauthorized), with model / api-level / abi. |
| `list_runs` | List debug runs under the run root, newest first, paginated. |

### Screen inspection & interaction

| Tool | What it does |
|---|---|
| `capture` | Screenshot and/or UI-hierarchy dump. `annotateElements:true` overlays numbered tap targets and returns the element map. |
| `screen_recording` | Explicit start/stop MP4 recording for motion-dependent evidence, plus one visual-change key-frame contact sheet under the same run. It is never started automatically; use screenshots/UI dumps when static evidence is enough. |
| `list_elements` | List on-screen interactive elements (resource-id / text / desc / bounds + a pre-computed tap center). Filter server-side: `resourceIdContains`, `clickableOnly`, `textContains`, `inViewport`, … |
| `tap` · `long_press` · `swipe` | Coordinate gestures on the active session. |
| `tap_node` | Tap a coordinate **and** resolve which node was hit + its nearest resource-id source anchor + ancestor chain — one call. |
| `send_key` | Send one hardware/navigation key (BACK, HOME, ENTER, …). |
| `input_text` | Type into the focused field via ADBKeyBoard; `sensitive:true` records only a length placeholder. |
| `map_ui_node_to_source` | Map a tapped node back to source — layout-id declaration, screen owner, code references. |

### Evidence & forensics

| Tool | What it does |
|---|---|
| `mark_event` | Append a named time marker to `events.jsonl` — anchors a point so later retrieval can scope a window around it. |
| `search_logs` | Search parsed logcat by substring / level / tag / pid / mark-window. `count:true + groupBy` aggregates log volume. |
| `search_evidence` | Search a profile-declared evidence source (e.g. `poppo_http`), paginated, pulled from the device on demand — with `bytesPulled` cost accounting. |
| `extract_evidence_context` | Records around a marker: single-source paginated, **or** a multi-source causal timeline merging logcat + events + profile sources by `tsMs` (logcat defaults to the app's pids, noisy tags dropped). |
| `extract_crash_context` | Raw-log context around a crash recorded in the run. |
| `perf_snapshot` | Live performance snapshot (cpu / mem / gfx) for the active session. |
| `collect_bundle` | Package a run folder into a portable bundle — hand to a teammate or attach to a ticket. |

> Profile-scoped tools (`search_evidence`, the profile sources in
> `extract_evidence_context`) only light up when `start_session` loaded a
> project profile. Point `projectRoot` at a repo carrying
> `.android-debug-mcp/profile.json`; otherwise `start_session` returns
> `profileName: null` and those sources report "no provider".

## Quickstart — the five scenarios

From a fresh shell, the first scenario should take well under five minutes.
Payloads below are the literal `arguments` an MCP host sends.

### A — Happy path: collect a run

```jsonc
android_debug_start_session { "packageName": "com.example.app", "launchOnStart": true }
//   → { "runId": "2026-05-20T08-11-05.530Z_5X9Q", "runDir": "...", ... }
android_debug_mark_event    { "runId": "<runId>", "name": "before_repro" }
//   ... drive the app ...
android_debug_stop_session  { "runId": "<runId>" }
android_debug_get_run_summary { "runId": "<runId>" }
//   → Markdown report: device / app / git provenance, counts, crashes, timeline
```

### B — Crash: pull the stack

```jsonc
android_debug_start_session { "packageName": "com.example.app", "launchOnStart": true }
//   ... reproduce the crash ...
android_debug_extract_crash_context { "runId": "<runId>", "beforeLines": 30, "afterLines": 60 }
//   → { "crashCount": 1, "type": "java", "mainException": "...", "topFrame": "...", "snippet": "..." }
```

A run with no crash returns `{ "crashCount": 0 }` — that is not an error.

### C — Interaction: drive the screen

```jsonc
android_debug_tap        { "runId": "<runId>", "x": 540, "y": 1200, "label": "Login button" }
android_debug_input_text { "runId": "<runId>", "text": "my-secret", "sensitive": true }
android_debug_send_key   { "runId": "<runId>", "key": "BACK" }
android_debug_capture    { "runId": "<runId>", "kinds": ["screenshot", "ui_dump"] }
```

`input_text` with `sensitive: true` records a length placeholder, never the
text. It also auto-redacts text that looks like a credential.

Record only when motion itself is evidence (transition timing, flicker,
dropped frames, or an intermediate state), or when the user explicitly asks
for video. Recording is not part of the default session path:

```jsonc
android_debug_screen_recording { "runId": "<runId>", "action": "start", "maxDurationSeconds": 4 }
// ... drive the repro with tap / swipe / send_key / input_text ...
android_debug_screen_recording { "runId": "<runId>", "action": "stop", "recordingId": "<recordingId>" }
//   → { videoPath: "artifacts/screenrecord-<recordingId>.mp4",
//       contactSheet: { path: "artifacts/screenrecord-<recordingId>-contact-sheet.png",
//         frameCount: 15, columns: 6, rows: 3,
//         order: "left_to_right_top_to_bottom", selection: "visual_change",
//         timestampsMs: [0, 267, 533, "..."] } }
```

Only one recording may be active per run. `stop_session` attempts to stop and
save an active recording if the caller omitted the explicit stop. Both the MP4
and contact sheet are included by `collect_bundle`. ffmpeg compares every decoded
frame with its predecessor instead of sampling fixed time intervals, retains the
first and last state, and selects up to 36 visually distinct changes. This keeps
single-frame flicker eligible while limiting redundant frames. Cells remain ordered
left-to-right then top-to-bottom; `timestampsMs[i]` identifies cell `i + 1`, so an
agent can inspect once and cite a cell or timestamp. If ffmpeg is unavailable or
fails, the MP4 remains valid evidence and the stop result reports
`contactSheet: null` plus a warning.

### D — Disconnect: degraded session

Unplug the device (or `adb disconnect <serial>`). Within ~5s the health poll
marks the session `degraded`:

```jsonc
android_debug_tap { "runId": "<runId>", "x": 1, "y": 1 }
//   → { "isError": true, "error": "device_disconnected" }
android_debug_search_logs  { "runId": "<runId>" }     // record-reading tools still work
android_debug_stop_session { "runId": "<runId>" }     // finalizes; summary status: "degraded"
```

### E — Orphan recovery

If the server process is killed (`kill -9`) mid-session, the run is left
unfinalized. The next server boot recovers it automatically:

```jsonc
android_debug_list_runs {}
//   → the killed run appears with "status": "aborted"
```

## Workflows — chaining tools for real debugging needs

The Quickstart shows tools in isolation. In practice an agent **composes** them:
one tool's output (a `runId`, a marker `ts`, a tapped node, a failing request)
feeds the next. Below are the chains that map to recurring debugging asks.

### W1 — "Which code draws this control / why does this tap do nothing?"

From a pixel on screen to the owning source.

```jsonc
android_debug_list_elements    { "runId": "<id>", "filter": { "resourceIdContains": "nav" } }
//   → narrows ~100 clickables down to the bottom-nav ids (no full-tree dump)
android_debug_tap_node         { "runId": "<id>", "x": 540, "y": 2288, "label": "tab: Dynamic" }
//   → { tappedNode, anchorNode, preTapForegroundActivity, ancestorChain }
android_debug_map_ui_node_to_source {
  "runId": "<id>",
  "anchorNode":         <tap_node.anchorNode>,
  "foregroundActivity": <tap_node.preTapForegroundActivity>,
  "ancestorChain":      <tap_node.ancestorChain>
}
//   → layout-id declaration, screen owner, code references (file:line)
```

Why this shape: `resourceIdContains` is the cheap selector — you pick the target
without fetching every element; `tap_node` resolves hit + anchor in one call;
its result feeds **straight** into `map_ui_node_to_source`, which lands on the
actual XML/Kotlin. The mapper runs against the recorded run + project source, so
it works on a finalized run too.

### W2 — "Reproduce a crash, get the stack + scene, hand it off"

```jsonc
android_debug_start_session    { "packageName": "com.example.app", "clearDeviceLogcat": true, "launchOnStart": true }
android_debug_mark_event       { "runId": "<id>", "name": "before_repro" }
//   ... drive the repro: tap / swipe / input_text ...
android_debug_extract_crash_context { "runId": "<id>", "beforeLines": 30, "afterLines": 60 }
//   → exception type, top frame, raw-log snippet around the crash
android_debug_search_logs      { "runId": "<id>", "afterMark": "before_repro", "level": "E" }
//   → app-side errors leading up to it
android_debug_collect_bundle   { "runId": "<id>" }
//   → a portable folder for the ticket / teammate
```

Why this shape: `clearDeviceLogcat` removes pre-repro noise; the marker anchors
"when it started"; crash context gives the stack, `search_logs` the lead-up,
`collect_bundle` the hand-off.

### W3 — "An API errored / a screen is slow — find the exact request + its context"

Profile-driven (Poppo/Vone `poppo_http`). Requires `projectRoot` at a repo with
`.android-debug-mcp/profile.json`.

```jsonc
android_debug_start_session    { "packageName": "com.baitu.poppo", "projectRoot": "/path/to/submodulepoppo" }
//   → profileName: "poppo-vone"  (else null → poppo_http has no provider)
android_debug_mark_event       { "runId": "<id>", "name": "symptom" }
//   ... reproduce ...
android_debug_search_evidence  { "runId": "<id>", "query": { "source": "poppo_http", "outcome": "http_error" } }
//   or: { "source": "poppo_http", "durationMsGte": 1000, "pathPrefix": "/live" }  → slow calls on a path
android_debug_extract_evidence_context {
  "runId": "<id>", "markerIsoTs": "<symptom ts>",
  "sources": [ { "source": "poppo_http" }, { "source": "logcat" }, { "source": "events" } ]
}
//   → the failing request merged with the logcat / nav around it, by tsMs
```

Why this shape: `search_evidence` filters the haystack by `outcome` /
`durationMsGte` / `pathPrefix` instead of scrolling logs; the multi-source
timeline then places that request next to what else happened at that instant.
`bytesPulled` in `statsRun` tells you what the on-demand pull actually cost.

### W4 — "A timing bug — lay out what happened on one causal line"

```jsonc
android_debug_mark_event       { "runId": "<id>", "name": "t0" }
//   ... trigger the sequence ...
android_debug_extract_evidence_context {
  "runId": "<id>", "markerIsoTs": "<t0 ts>", "beforeMs": 3000, "afterMs": 8000,
  "sources": [ { "source": "poppo_nav" }, { "source": "poppo_http" },
               { "source": "events" }, { "source": "logcat", "level": "W" } ]
}
//   → nav + http + UI events + (app-pid-scoped, compacted) logcat, merged by time
android_debug_search_logs      { "runId": "<id>", "count": true, "groupBy": "tag" }
//   → if the timeline truncated, find which tag is flooding it
android_debug_search_logs      { "runId": "<id>", "afterMark": "t0", "tags": ["YourTag"] }
//   → drill to the raw lines that matter
```

Why this shape: the timeline gives **signal** — since 0.7.4 logcat defaults to
the app's own pids and drops profile-declared noisy tags, so OS chatter
(`system_server`, `systemui`) no longer buries the app's lines. When it
truncates, `count + groupBy` names the flooder; then you fetch raw lines on
demand.

### W5 — "Capture perf + compare against a previous run"

```jsonc
android_debug_mark_event       { "runId": "<id>", "name": "before_scroll" }
//   ... scroll the list ...
android_debug_perf_snapshot    { "runId": "<id>", "kinds": ["gfxinfo", "meminfo"] }
//   → parsed gfxinfo (jank/frame) + meminfo digest
android_debug_stop_session     { "runId": "<id>" }
android_debug_list_runs        {}
//   → pick the baseline run from a previous build
android_debug_get_run_summary  { "runId": "<baseline>" }
//   → diff provenance (git sha, app version) + counts + perf between the two
```

Why this shape: snapshots + markers capture the moment; `list_runs` /
`get_run_summary` turn "is this worse than last build?" into a side-by-side on
two folders that each pin their own git/app provenance.

## Typing text (ADBKeyBoard)

`android_debug_input_text` delivers text through the **ADBKeyBoard** helper IME
(<https://github.com/senzhk/ADBKeyBoard>) so any input — ASCII, CJK, emoji,
punctuation — is typed by one code path. Install the APK once on the device;
the tool selects it as the active IME automatically. If ADBKeyBoard is missing,
`input_text` returns `{ "error": "input_method_unavailable" }`.

## Coexisting with mobile-mcp

This server collects *debug evidence* and drives the screen by coordinates. If
you also need *element-based* automation (finding and tapping views by their
accessibility tree), run a tool like
[mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) alongside it
— register both in your host's `mcpServers`. They are complementary: each owns
its own concern, and android-debug-mcp does not touch the accessibility tree.

## Development

```sh
git clone https://github.com/est7/android-debug-mcp
cd android-debug-mcp
bun install

bun run typecheck   # tsc --noEmit
bun run lint        # biome check .
bun run test        # vitest run
bun run dev         # run the stdio server directly
```

No build step — the server runs straight from TypeScript under Bun. See
[`docs/test-plan.md`](./docs/test-plan.md) for the manual 5-scenario device
checklist.

## Documents

| File | Purpose |
|---|---|
| [`docs/design-lock-v1.md`](./docs/design-lock-v1.md) | 17 locked v1 decisions + acceptance criteria + out-of-scope |
| [`docs/decision-amendments.md`](./docs/decision-amendments.md) | Increments and reversals beyond the lock (Q1/Q2 + codex audit findings) |
| [`docs/v1-implementation-plan.md`](./docs/v1-implementation-plan.md) | The phased implementation plan |
| [`docs/test-plan.md`](./docs/test-plan.md) | Manual 5-scenario device checklist |
| [`docs/audits/`](./docs/audits/) | Per-phase Codex audit reports |
| [`docs/backlog.md`](./docs/backlog.md) | v1.1 / v2 / v3 deferred capabilities |
