# Review Issue #003: cache.ts 中 anthropicCacheControl() 已成死代码

## 严重程度：低

## 位置
- `packages/llm/src/cache.ts` (L67-73)

## 描述

`anthropicCacheControl()` 函数是旧架构中为 AI SDK `@ai-sdk/anthropic` 的 `providerOptions` 构造 `cacheControl` 注入的辅助函数。

新架构中，Anthropic 的 prompt caching 改为在 `anthropic-client.ts` 的 `toAnthropicFormat()` 中直接注入 `cache_control` 字段（单路径）。搜索全代码库，`anthropicCacheControl` 无任何调用方。

同样，cache.ts 文件头注释仍引用 `adapter.ts` 和 `provider.ts`，两者均已在 Step 5 (c3fcf06) 删除。

## 建议

删除 `anthropicCacheControl()` 函数，更新 cache.ts 文件头注释。
