# Review Issue #016: StreamRequest.promptMessages 旁路是 Plan 外的设计变更

## 严重程度：低（设计偏差，非 bug）

## 位置
- `packages/types/src/client.ts` (StreamRequest)
- `packages/tools/src/editor-loop.ts`
- `packages/llm/src/openai-client.ts` (L217)
- `packages/llm/src/anthropic-client.ts` (L264)

## 描述

Plan §3.2 定义的 `StreamRequest` 接口为：

```ts
interface StreamRequest {
    messages: DomainMessage[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
}
```

实际实现中增加了 Plan 未提及的字段：

```ts
interface StreamRequest {
    messages: DomainMessage[];
    promptMessages?: PromptMessage[];  // ← Plan 中不存在
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
}
```

当 `promptMessages` 存在时，Client 跳过 `formatPrompt` 直接使用预格式化的消息。这是为 editor-loop 设计的，因为 editor-loop 内部维护 `PromptMessage[]` 而非 `DomainMessage[]`。

**技术上可行**，但引入了 LLMClient 接口的"逃生舱口"：调用方可以绕过领域消息层直接构造协议级消息，打破了 Plan 设计的分层隔离。

## 影响

不影响功能。但如果未来有更多调用方使用此旁路，会削弱 DomainMessage 作为唯一数据源的 SSOT 地位。

## 建议

在注释中明确标记 `promptMessages` 为内部使用字段（`@internal`），或考虑为 editor-loop 提供独立的底层 API（如 `streamRaw()`）。
