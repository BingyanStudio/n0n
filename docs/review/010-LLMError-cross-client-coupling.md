# 010 — LLMError 仅定义在 openai-client，Anthropic 复用时产生耦合

**严重度**: 🟢 低（违背关注点分离）
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`, `packages/llm/src/index.ts`

## 问题描述

`LLMError` class 定义在 `openai-client.ts` 中：

```ts
// openai-client.ts
export class LLMError extends Error {
    constructor(message: string, public status: number, public body: unknown) { ... }
}
```

Anthropic Client 从 OpenAI Client 导入使用：

```ts
// anthropic-client.ts
import { LLMError } from "./openai-client.ts";
```

`index.ts` 也从 OpenAI Client 导出：

```ts
// index.ts
export { LLMError } from "./openai-client.ts";
```

## 违背原则

**关注点分离违背**：`LLMError` 是两个 Client 共用的错误类型，不应属于任何一个特定 Client。Anthropic Client 依赖 OpenAI Client 的导出，两个本应平行独立的实现之间产生了不必要的耦合。

## 建议

将 `LLMError` 提取到独立文件（如 `packages/llm/src/errors.ts`），两个 Client 各自导入。
