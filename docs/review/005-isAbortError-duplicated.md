# 005 — isAbortError 在两个 Client 中重复定义

**初评严重度**: 🟡 中（违背 SSOT）
**二次审查**: 🟢 **降级 — 过度工程化，不构成维护风险**
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 初评描述

两个文件各自定义了 3 行完全相同的 `isAbortError` 函数。初评建议提取到共享模块。

## 二次审查：3 行工具函数不值得提取

### 1. 函数极其稳定

`isAbortError` 的逻辑（`err instanceof Error && err.name === "AbortError"`）是 Web API 标准行为判定，几乎不会变更。「将来 bun 特有的 abort 错误」的担忧是假设性的——如果真发生了，改两处的成本也是 30 秒。

### 2. 提取的代价

为 3 行函数创建 `utils.ts`，需要：
- 新增一个文件
- 两处改为 import
- 多一层间接（读代码时需要跳转）

收益：消除 3 行重复。成本/收益比太高。

### 3. 与 010 一起处理是合理的

如果 010（LLMError 提取到 errors.ts）被执行，那么顺便把 `isAbortError` 也放进去是合理的——因为已经有了共享文件，边际成本为零。但不应为 `isAbortError` 单独创建文件。

## 结论

**不建议单独行动**。如果 010 被执行（创建 `errors.ts`），可以顺带移入。否则保持现状。
