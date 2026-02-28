# Patch 1 — 审计修复

> 日期：2026-02-28 | 对应审计：`docs/audit.md`

## 已修复

### 1. `delegateTask` 咨询步骤不再吞没致命错误

**位置**：[`delegate.ts`](../src/task/delegate.ts)

之前所有异常（包括 401/403 认证错误）都被 catch-all 静默降级为 `"(consultation unavailable)"`。现在区分致命错误（401/403 直接 throw）和可恢复错误（超时、网络等降级处理并打印日志）。

### 2. 泛型 `TaskResult<T>` / `AgentResult<T>` 真正生效

**位置**：[`loop.ts`](../src/agent/loop.ts)、[`subagent.ts`](../src/agent/subagent.ts)、[`delegate.ts`](../src/task/delegate.ts)

之前 `AgentResult<T>`、`SubagentOptions`、`AgentOptions`、`TaskResult<T>` 的泛型参数是装饰性的——`schema` 字段类型为 `ZodType`（无泛型），导致 `result` 始终为 `unknown`。

现在整条链路 `AgentOptions<T>` → `agentLoop<T>` → `SubagentOptions<T>` → `subagent<T>` → `delegateTask<T>` 的泛型参数与 `ZodType<T>` 绑定。传入 Zod schema 时，返回值 `result` 的类型会被正确推断。

`AgentResult.result` 类型改为 `T | null`（null 表示 agent 超过最大轮次未 submit 的边界情况）。

### 3. `expectedReplaceTime` → `expectedMatches`

**位置**：[`definitions.ts`](../src/tools/definitions.ts)、[`write.ts`](../src/tools/write.ts)

参数名从 `expectedReplaceTime`（易误解为超时时间）改为 `expectedMatches`（明确表示期望匹配次数）。

## 待办（审计中标记但暂不实现）

| 项目 | 原因 |
|------|------|
| 定期反思机制 | 后续实现 |
| exec 安全边界 | 暂不处理 |
| RAG 中文分词 + 语义检索 | 后续迭代 |
| Scheduler 并发锁 | 不影响功能 |
| DomainMessage `string \| null` | 字段本身可选是正确的 |
