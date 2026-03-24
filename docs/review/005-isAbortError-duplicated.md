# 005 — isAbortError 在两个 Client 中重复定义

**严重度**: 🟡 中（违背 SSOT）
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 问题描述

两个文件中各自定义了完全相同的 `isAbortError` 函数：

```ts
// openai-client.ts
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}

// anthropic-client.ts
function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === "AbortError";
}
```

## 违背原则

**SSOT 违背**：相同逻辑在两处定义。虽然函数很小，但如果将来 AbortError 的判定逻辑变更（例如需要处理 bun 特有的 abort 错误类型），需要修改两处。

## 建议

提取到共享位置，例如 `packages/llm/src/utils.ts` 或直接在两个 Client 的共同基础模块中定义。作为 `@n0n/llm` 内部共享函数，不需要暴露给外部。
