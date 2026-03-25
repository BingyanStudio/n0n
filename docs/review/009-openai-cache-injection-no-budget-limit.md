# Review Issue #009: OpenAI Client 的 litellm cache 注入没有 budget 限制

## 严重程度：中

## 位置
- `packages/llm/src/openai-client.ts` (L222-232)

## 描述

OpenAI Client 在检测到 `backendProvider === "anthropic"`（litellm 代理场景）时，调用 `selectCacheBreakpoints(apiMessages)` 并注入 `cache_control`。

然而：

1. `selectCacheBreakpoints()` 最多返回 4 个断点
2. OpenAI Client 没有像 Anthropic Client 那样减去 system 已占用的 cache 配额

在 litellm 代理场景中，litellm 会将 OpenAI 格式的 `cache_control` 字段透传为 Anthropic 的 `cache_control`。如果 system 消息单独计算也被加了缓存标记，可能导致总共超过 Anthropic 的 4 个限制。

**对比 Anthropic Client** (commit cb40807 修复后)：
```ts
let cacheCount = 0;
if (systemParts.length > 0) {
    systemParts[systemParts.length - 1]!.cache_control = { type: "ephemeral" };
    cacheCount++;
}
const maxMessageBreakpoints = 4 - cacheCount;
const breakpoints = selectCacheBreakpoints(messages).slice(0, maxMessageBreakpoints);
```

OpenAI Client 中没有对应的 budget 减法。不过由于 OpenAI 格式中 system 消息是作为 messages 数组的一部分（而非 Anthropic 的独立 system 字段），`selectCacheBreakpoints` 的结果已经包含了 system 消息的索引，所以实际上可能不会超出 4 个。但应确认 litellm 是否会额外注入 system 缓存。

## 建议

验证 litellm 场景下 cache_control 总数是否确实 ≤ 4，如有必要添加同样的 budget 限制逻辑。
