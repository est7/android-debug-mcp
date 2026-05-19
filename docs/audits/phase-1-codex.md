# Phase 1 — Codex audit reply (round 1)

**Date:** 2026-05-19
**Thread:** `review/phase-1`
**Outcome:** **patch-required** (1 Major + 5 Minor)
**Source message id:** `2026-05-19T10-27-17.013Z_pid95271_8a80cc18`

---

## Findings

### Major
- **[P1-M1]** [`server/src/adb/adb.ts:28-33,61-66`] — `ADB_PATH` override 只缓存字符串不验证可执行文件,`Bun.spawn` 失败时会泄出 raw `ENOENT` 而不是 `AdbNotFoundError`;改成在 `getAdbPath()` 验证 override 可执行,或在 `runAdb`/`spawnAdb` 捕获 `posix_spawn ENOENT` 并转成 `AdbNotFoundError([\`ADB_PATH=${envOverride}\`])`,同时加一条坏 `ADB_PATH` 单测。验证证据: `ADB_PATH=/definitely/missing/adb runAdb(["version"])` 当前返回 `{name:"Error", code:"ENOENT"}`。

### Minor / deferred
- **[P1-m1]** [`server/src/mcp/register.ts:130-143`] — `.strict()` 检查读 `ZodObject._def.unknownKeys`,这是 Zod 3 内部字段;v1 可以接受,因为 `safeParse({__probe:1})` 对带 required fields 的通用 schema 不能可靠区分 unknown-key 失败和 required-field 失败。补一条注释说明依赖 Zod 3,并保留现有 register helper test 即可。
- **[P1-m2]** [`server/src/mcp/register.ts:80-89`] — double-parse 不构成 perf 问题,但 helper 目前允许非 object `outputSchema`,而 MCP `structuredContent` 是 object contract。把 `outputSchema` 也限制为 `ZodObject` 或新增 boot-time assert,防未来 tool 用 `z.array(...)` 时 tools/list 没有有效 outputSchema。
- **[P1-m3]** [`server/src/mcp/tools/list_devices.ts:20-34`] — `apiLevel.max(99)` 是无收益上限,未来 Android API 到 100 会让 outputSchema 把真实设备结果打成 tool error。改成 `.max(999)` 或去掉 max,保留 `.int().min(1)`。
- **[P1-m4]** [`server/src/adb/devices.ts:91-119`] — `parseTrailingFields` 的 `Record<string,string>` cast 不是 correctness bug,但真实原因是 `Pick<DeviceListEntry,...>` 保留了 readonly。改成本地 mutable type `{ transportId?: string; product?: string; model?: string; device?: string }`,直接赋值即可,不需要 cast。
- **[P1-m5]** [`server/tests/adb/devices.test.ts:33-54`] — parser 接受 `authorizing/recovery/sideload/bootloader`,但 fixture 没覆盖。补一条 table test 覆盖这些 state,避免后续正则改动时误删。

---

## Answers to requested audit points (from codex)

1. **Register helper completeness**: prefix / inventory / annotation hints 都挡住了;input strict 当前能挡,但依赖 Zod 3 internal `_def.unknownKeys`;description substring 足够,不值得做 header parser;output double-parse可接受,但应禁止 non-object output schema。
2. **17-tool inventory enforcement**: 同意保留。v1 是锁定 17-tool 表面,inventory 比只查 prefix 更能防 typo drift,不是 overreach。
3. **`parseDevicesL`**: unknown line 返回 `state:"unknown"` 比 silent drop 好,因为 adb 输出异常本身是诊断信号;需要补 `authorizing/recovery/sideload/bootloader` fixture。
4. **`listDevices()` getprop**: getprop 空输出 → null 合理;per-device 三个 getprop 并发对 v1 单设备可接受;`apiLevel.max(99)` 应放宽。
5. **TS strict edge**: destructuring 后 null check OK;`parseTrailingFields` cast 可以换 mutable local type,不影响 Phase 1 correctness。
6. **Phase 2 前**: 必须先修 [P1-M1];minor 可随同 patch 一起做,或记录后继续。

## Verification codex ran

- `bun run typecheck` ✅ 0 error
- `bun run lint` ✅ 16 files, no errors
- `bun run test` ✅ 13/13
- Bad `ADB_PATH` probe ✅ reproduced raw `ENOENT` leak
- Bun kill probe ✅ `child.kill()` exits with code 143, so timeout 注释中 `exitCode=-1` 是 stale 注释 — 不是 Phase 1 blocker,我方记入「不在范围」顺手修

## Patch plan(本方接受)

1. [P1-M1] `getAdbPath()` 验证 `ADB_PATH` override 可执行(`accessSync(X_OK)`)+ `runAdb`/`spawnAdb` 兜底捕获 ENOENT → AdbNotFoundError;补一条 bad `ADB_PATH` 测试
2. [P1-m1] register helper `_def.unknownKeys` 检查加 Zod 3 dependency 注释
3. [P1-m2] register helper boot-time assert `outputSchema instanceof z.ZodObject`
4. [P1-m3] list_devices `apiLevel.max(999)`
5. [P1-m4] `parseTrailingFields` 改 mutable local type,删 cast
6. [P1-m5] 补 fixture 或 table test 覆盖 `authorizing/recovery/sideload/bootloader`
7. 顺手:`runAdb` timeout 注释更正为 SIGTERM exit code 143

---

# Phase 1 — Codex audit reply (round 2 · sign-off)

**Date:** 2026-05-19
**Thread:** `review/phase-1`
**Outcome:** **sign-off** — Phase 1 may proceed to Phase 2.
**Source message id:** `2026-05-19T10-38-53.972Z_pid7636_cf248ca8`

## Patch verification (codex)

- **[P1-M1] fixed** — `runAdb` and `spawnAdb` no longer leak raw `ENOENT` for bad `ADB_PATH`; both paths now surface `AdbNotFoundError` with `code:"adb_not_found"` and the user-supplied `ADB_PATH` in the message.
- **[P1-m1] addressed** — the Zod 3 `_def.unknownKeys` dependency is documented with the correct reason why generic `safeParse({__probe:1})` is not a reliable replacement.
- **[P1-m2] addressed** — `registerDebugTool` now rejects non-object output schemas at boot.
- **[P1-m3] addressed** — `apiLevel` ceiling widened to 999.
- **[P1-m4] addressed** — `parseTrailingFields` now uses a mutable local type instead of `Record<string,string>` casts.
- **[P1-m5] addressed** — `authorizing` / `recovery` / `sideload` / `bootloader` states are covered by tests.

## Verification codex ran (round 2)

- `bun run typecheck` ✅ 0 error
- `bun run lint` ✅ 17 files, no errors
- `bun run test` ✅ 18/18
- Bad `ADB_PATH` direct probe for `runAdb(["version"])` ✅ returns `{name:"AdbNotFoundError", code:"adb_not_found"}`
- Bad `ADB_PATH` direct probe for `spawnAdb(["logcat"])` ✅ returns `{name:"AdbNotFoundError", code:"adb_not_found"}`
- `getAdbPath()` happy probe ✅ resolves `/Users/est9/Library/Android/sdk/platform-tools/adb`

## Codex notes for Phase 2

> No blocker carried forward. Keep the same pattern: typed errors at the boundary, fail-fast helper validation, and exact local repro probes for edge cases that unit tests cannot fully cover.

(These three principles carry into Phase 2: typed errors at FS / lock / metadata boundary, fail-fast at boot for storage helpers, real-FS repro for orphan recovery cases.)

