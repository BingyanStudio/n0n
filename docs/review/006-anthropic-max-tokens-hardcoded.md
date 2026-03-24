# 006 — Anthropic max_tokens 硬编码，未走统一配置路径

**严重度**: 🟡 中（违背 SSOT）
**文件**: `packages/llm/src/anthropic-client.ts`, `packages/llm/src/config.ts`

## 问题描述

Anthropic Client 中 `max_tokens` 存在多处硬编码默认值：

### stream() 方法
```ts
const defaultMaxTokens = this.config.maxOutputTokens ?? 8192;
// ...
if (this.config.enableThinking) {
    body.max_tokens = Math.max(defaultMaxTokens, budget + 4096);  // 4096 也是硬编码
}
```

### complete() 方法
```ts
max_tokens: this.config.maxOutputTokens ?? 4096,
```

## 违背原则

1. **SSOT 违背**：stream 默认 8192，complete 默认 4096，两处不同的默认值分散在方法内部。这些默认值应该定义为具名常量。
2. **隐含知识**：thinking 模式下 `budget + 4096` 的额外 buffer 是 Anthropic 的特定要求，但没有注释说明 4096 的来源和含义。

## 建议

在 `config.ts` 中定义具名常量：

```ts
export const DEFAULT_ANTHROPIC_STREAM_MAX_TOKENS = 8192;
export const DEFAULT_ANTHROPIC_COMPLETE_MAX_TOKENS = 4096;
export const ANTHROPIC_THINKING_OUTPUT_BUFFER = 4096;
```

并在使用处引用，便于理解和统一修改。
