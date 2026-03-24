# Review Issue #005: OpenAI SSE 中 usage 与 finish_reason 顺序依赖问题

## 严重程度：中

## 位置
- `packages/llm/src/openai-client.ts` (L312-358)

## 描述

当前 OpenAI SSE 解析逻辑中，`usage` 和 `finish_reason` 的处理存在顺序依赖：

```ts
// L312: 先处理 usage
if (chunk.usage) {
    lastUsage = { ... };
}
// L353: 后处理 finish_reason，使用 lastUsage
const finish = chunk.choices?.[0]?.finish_reason;
if (finish) {
    yield { type: "done", finishReason: finish, usage: lastUsage };
}
```

**问题**：部分 OpenAI-compatible provider（如 DeepSeek）会在 `finish_reason` chunk 之后、`[DONE]` 之前发送一个独立的 usage-only chunk（只有 `usage` 字段，没有 `choices`）。在这种情况下：

1. `finish_reason` chunk 到达时，`lastUsage` 仍为 null
2. `done` 事件被 yield 出去，usage 为 null
3. 随后的 usage-only chunk 更新了 `lastUsage`，但 `done` 事件已经发出
4. 接着 `[DONE]` 触发 return，usage 数据丢失

此外，当前没有向 OpenAI API 发送 `stream_options: { include_usage: true }`，部分 provider 可能不会默认在流式响应中包含 usage。

## 影响

部分 provider 下 `StreamEvent.done` 的 `usage` 字段可能为 null，导致 token 用量统计不可用。不影响功能正确性。

## 建议

1. 在 request body 中添加 `stream_options: { include_usage: true }`
2. 如果 `done` 事件的 usage 为 null，在后续收到 usage chunk 时可以考虑再 yield 一个更新事件，或延迟 done 事件的发出
