# 002 — StreamRequest.promptMessages 旁路破坏了 LLMClient 抽象层

**严重度**: 🟡 中（违背关注点分离）
**文件**: `packages/types/src/client.ts`, `packages/tools/src/editor-loop.ts`, `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 问题描述

`StreamRequest` 接口中有一个 `@internal` 标记的 `promptMessages` 字段：

```ts
export interface StreamRequest {
    messages: DomainMessage[];
    /** @internal 仅供 editor-loop 等内部模块使用 */
    promptMessages?: PromptMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
}
```

当 `promptMessages` 被设置时，两个 Client 都跳过 `formatPrompt`：

```ts
const promptMessages = request.promptMessages ?? formatPrompt(request.messages, this.modelId);
```

## 违背原则

1. **关注点分离违背**：`LLMClient` 的核心职责之一是 DomainMessage → PromptMessage 转换。`promptMessages` 旁路让调用方直接传入已格式化消息，使得 Client 接口承担了两种不同的调用契约。

2. **抽象泄漏**：`PromptMessage` 是 Client 内部格式，但通过 `StreamRequest.promptMessages` 暴露给了上层（editor-loop）。这意味着 editor-loop 必须自己构造 PromptMessage，绕开了 DomainMessage 领域层。

3. **plan 偏离**：plan 中 `LLMClient.stream()` 的职责明确为"接受 DomainMessage[]，内部完成提示词组织"，而 `promptMessages` 破坏了这个契约。

## 建议

editor-loop 应该构造 DomainMessage[] 而非直接构造 PromptMessage[]，或者为 editor-loop 定义一个独立的 `streamRaw()` 方法，明确分离两种调用模式。
