# Review Issue #006: Anthropic Client max_tokens 硬编码

## 严重程度：中

## 位置
- `packages/llm/src/anthropic-client.ts` (L269, L488)

## 描述

AnthropicClient 的 `max_tokens` 在两处硬编码：

1. **stream()** (L269): `max_tokens: 8192`
2. **complete()** (L488): `max_tokens: 4096`

Anthropic API 要求必须传 `max_tokens`，这一点无误。但问题是：

1. 不同模型有不同的 `max_output_tokens` 上限（Claude 3.5 Sonnet 为 8192，Claude 3 Opus 为 4096，Claude 4 可能更高）。硬编码 8192 可能不适用于所有模型。

2. 当 `enableThinking` 开启时 (L285)，`max_tokens` 被设为 `Math.max(8192, budget + 4096)`。对于默认的 `budget = 1024`，结果为 8192 不变。但如果用户设置更大的 thinking budget（如 10000），则 max_tokens = 14096，这可能超过模型上限。

3. LLMConfig 中没有 `maxOutputTokens` 配置项，用户无法自定义。

## 影响

- 大部分场景下 8192 足够，但不够灵活
- thinking 大预算场景可能超模型限制导致 API 400 错误

## 建议

在 LLMConfig 中添加可选的 `maxOutputTokens` 字段，带合理默认值。
