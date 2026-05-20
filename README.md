# android-debug-mcp

> 中文文档:[readme-zh.md](./readme-zh.md)

A local **stdio MCP server** for **Android application-layer debug evidence
collection**. It gives an MCP agent a session-scoped, audited way to drive a
real device over `adb` — launch an app, reproduce a bug, interact with the
screen, and collect logcat / crashes / screenshots into a self-contained run
folder.

It is *evidence-first*: every tool call is recorded, every run is a folder on
disk you can inspect, bundle, or hand to a teammate. It deliberately does **not**
do element-based UI automation (no AccessibilityService, no view-tree tapping) —
see [Coexisting with mobile-mcp](#coexisting-with-mobile-mcp).

Status: **v1 (0.1.0)** — all 17 tools registered; the five acceptance scenarios pass on-device.

## Prerequisites

- **Bun ≥ 1.1** — the runtime (`engines.bun` in `package.json`).
- **`adb`** on `PATH` (Android platform-tools), or `ADB_PATH` pointing at the binary.
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

## The 17 tools

Every tool is named `android_debug_*`. On **success** it returns
`structuredContent`. A recoverable **failure** instead returns
`{ isError: true }` with the JSON `{error, message, …}` payload in
`content[0].text` and **no** `structuredContent` — the agent branches on that
payload; it is never raised as a raw protocol error.

| Group | Tools |
|---|---|
| **Session lifecycle** | `start_session`, `stop_session`, `mark_event`, `get_app_state`, `app_control`, `clear_app_data` |
| **Interaction** | `tap`, `input_text`, `send_key`, `swipe`, `capture` |
| **Evidence retrieval** | `search_logs`, `extract_crash_context`, `get_run_summary` |
| **Device & run management** | `list_devices`, `list_runs`, `collect_bundle` |

A session is a singleton per `(deviceSerial, userId, packageName)` tuple — one
active run per app per device. Every interaction/evidence call carries the
`runId` returned by `start_session`.

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
