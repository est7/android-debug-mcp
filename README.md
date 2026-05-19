# android-debug-mcp

Local stdio MCP server for **Android application-layer debug evidence collection**.

Status: **v1 in implementation** — Phase 0 scaffold landed. See `docs/` for the locked design contract.

## Documents

| File | Purpose |
|---|---|
| [`docs/design-lock-v1.md`](./docs/design-lock-v1.md) | 17 locked v1 decisions + acceptance criteria + out-of-scope |
| [`docs/decision-amendments.md`](./docs/decision-amendments.md) | Lock 之外的增量与翻案(Q1/Q2 + codex audit findings) |
| [`docs/v1-implementation-plan.md`](./docs/v1-implementation-plan.md) | 12-phase implementation plan |
| [`docs/audit-2026-05-19-codex.md`](./docs/audit-2026-05-19-codex.md) | Codex audit findings (archived) |
| [`docs/backlog.md`](./docs/backlog.md) | v1.1 / v2 / v3 deferred capabilities + v1 spikes |

## Quickstart (dev)

Requires Bun ≥ 1.1 and `adb` on `PATH`.

```sh
bun install
bun run typecheck
bun run dev   # stdio MCP server; talk to it via an MCP host
```

Full `mcp.json` snippets for Claude Code / Cursor / Codex come in Phase 11 of the plan.
