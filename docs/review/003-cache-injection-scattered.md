# 003 — Cache 断点注入逻辑分散在两个 Client 中

**严重度**: 🟡 中（违背 SSOT）
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`, `packages/llm/src/cache.ts`

## 问题描述

`cache.ts` 提供了 SSOT 的断点选择算法 `selectCacheBreakpoints()`，这部分设计良好。
但 **cache_control 的注入逻辑** 分散在两个 Client 中，且实现方式不同：

### OpenAI Client（litellm 代理场景）
```ts
// openai-client.ts ~L175
const breakpoints = selectCacheBreakpoints(apiMessages).slice(0, 4);
for (const idx of breakpoints) {
    (msg as unknown as Record<string, unknown>).cache_control = { type: "ephemeral" };
}
```

### Anthropic Client
```ts
// anthropic-client.ts toAnthropicFormat() 内部
// 1. system 部分：最后一个 block 加 cache
systemParts[systemParts.length - 1]!.cache_control = { type: "ephemeral" };
// 2. messages 部分：selectCacheBreakpoints + 转 content block
```

## 违背原则

1. **SSOT 违背**：cache 注入的 "怎么注入" 散落在两个 Client 中，且逻辑不一致（OpenAI 直接加字段，Anthropic 需要转 content block）。
2. **关注点分离不足**：Anthropic Client 的 `toAnthropicFormat()` 函数同时承担了消息格式转换和缓存注入两个职责，一个纯转换函数不应有副作用地修改输入结构。

## 建议

将缓存注入逻辑提取为独立函数（如 `injectCacheBreakpoints(messages, format)`），使 cache 策略与消息转换分离。`toAnthropicFormat` 应该是纯格式转换，缓存注入作为后处理步骤。
