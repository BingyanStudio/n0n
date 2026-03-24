# Review Issue #002: config.ts 中残留过时的 AI SDK 注释和废弃类型

## 严重程度：低

## 位置
- `packages/llm/src/config.ts`

## 描述

config.ts 中多处注释仍引用已删除的 AI SDK 概念：

1. **文件头注释** (L5): `由 createLanguageModel() 工厂函数构造 LanguageModel 实例` — `createLanguageModel` 和 `LanguageModel` 已不存在，应改为 `createLLMClient()`。

2. **ThinkingProviderOptions 类型** (L19-23): 注释写 `旧 AI SDK 架构下用于 streamText() 的 providerOptions 参数。新架构中 thinking 配置内化到各 Client，此类型仅保留向后兼容` — 但搜索全代码库，此类型无任何消费方。应直接删除。

3. **AnthropicProviderConfig 注释** (L40): `使用 @ai-sdk/anthropic SDK` — 已不使用 AI SDK。

4. **OpenAICompatibleProviderConfig.backendProvider 注释** (L71): `AI SDK 的 @ai-sdk/openai provider 不会传递 provider-specific 字段` — 应更新为新架构描述。

## 影响

代码可编译运行，但过时注释会误导后续维护者对架构的理解。

## 建议

更新所有注释为当前架构的描述，删除 `ThinkingProviderOptions` 类型。
