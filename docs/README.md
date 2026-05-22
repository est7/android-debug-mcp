# android-debug-mcp · docs

项目文档树。代码进 `server/`,设计与决策进这里。

## 索引

| 文件 | 内容 | 状态 |
|---|---|---|
| [`design-lock-v1.md`](./design-lock-v1.md) | v1 设计决策正本(17 项决策 + 假设 + 验收 + 显式 out-of-scope) | locked 2026-05-19 |
| [`decision-amendments.md`](./decision-amendments.md) | lock 之外的增量与翻案(§ A Q2 logcat / § B Q1 mobile-mcp / § C-D-E codex audit r1 / § F 参考实现 / § G MCP best practices r2) | living |
| [`v1-implementation-plan.md`](./v1-implementation-plan.md) | 12-phase 实施计划(含 Q2 防御点)+ 13 项 open implementation decision;实施前需对照 amendments § C-E 修订 | locked 2026-05-19 |
| [`audit-2026-05-19-codex.md`](./audit-2026-05-19-codex.md) | codex audit 原文留档(5 critical / 13 major / 5 minor / 8 correctly-locked) | archived 2026-05-19 |
| [`backlog.md`](./backlog.md) | v1.1 / v2 / v3 留档 + v1-spike(audit 中立未决项) | living |
| [`v2/source-mapping.md`](./v2/source-mapping.md) | v2-A 设计 lock(tap-to-source;grill Q1–Q10 + codex 复审) | locked 2026-05-21 |
| [`v2/v2-a-implementation-plan.md`](./v2/v2-a-implementation-plan.md) | v2-A 实施计划(6 phase + 并行 + 风险 + open decisions) | locked 2026-05-21 |
| `architecture.md` | 系统架构图、session 生命周期、数据流 | v1.1(未建立) |
| [`test-plan.md`](./test-plan.md) | 5 scenario 真机 manual checklist | Phase 11 落盘 |
| [`audits/`](./audits/) | 各阶段 codex audit 报告原文(phase-1 … phase-N) | living |

## 编辑约定

- 新增文档进这层或子目录,同步更新本索引。
- `design-lock-v1.md` 一旦 lock 不再就地改;v1 实施过程中若发现决策需翻案,新增 `decision-amendments.md` 记录原决策、新决策、原因。
- `backlog.md` 是 living 文档;条目落到 v1.1 / v2 / v3 时,把对应内容 promote 到独立设计文档(如 `docs/v2/source-mapping.md`),然后从 backlog 划掉。
