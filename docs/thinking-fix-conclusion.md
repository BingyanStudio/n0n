# Thinking 链路修复 — 结论与方案

## 问题

`LLM_ENABLE_THINKING=true` 在 AI SDK 重构后失效，涉及三个断裂点：

1. **thinking 参数不传递** — `enableThinking` 未通过 `providerOptions` 传给 `streamText()`
2. **openai-compatible 不解析 reasoning** — AI SDK chat completions 不处理 `delta.reasoning_content`
3. **交替思考回归** — `adapter.ts` 不再将历史 reasoning 回传给 API

## 验证结论

实测 ppio 的 `/anthropic` 端点（`@ai-sdk/anthropic` + 自定义 baseURL）：
- ✅ thinking 流式输出（自动返回，`thinking_delta` → `reasoning-delta`）
- ✅ tool calling 正常
- ✅ cacheControl 兼容
- ✅ `providerOptions.anthropic.thinking` 配置生效

对比 `/openai` 端点（`@ai-sdk/openai` `.chat()` 路径）：
- ❌ `delta.reasoning_content` 被 AI SDK 完全忽略

**结论：代理提供 anthropic 兼容协议时，使用 `provider: "anthropic"` + `baseUrl` 即可，无需独立的 `anthropic-compatible` 类型。**

## 修复内容

| 文件 | 改动 |
|------|------|
| `packages/llm/src/config.ts` | `AnthropicProviderConfig` 增加 `baseUrl?`；导出 `DEFAULT_THINKING_BUDGET_TOKENS`、`isAnthropicProvider()`、`ThinkingProviderOptions` 类型 |
| `packages/llm/src/provider.ts` | `anthropic` 分支统一处理 baseUrl |
| `packages/llm/src/config-from-env.ts` | `inferProvider` → `resolveProvider`（去掉 URL 模糊推断）；修复 budgetTokens 0 值陷阱 |
| `packages/llm/src/thinking.ts` | 使用 SSOT 常量和 `isAnthropicProvider()`；返回 `ThinkingProviderOptions` |
| `packages/llm/src/stream.ts` | `providerOptions` 类型从 `unknown` 改为 `ThinkingProviderOptions`；去掉 `as any` |
| `packages/llm/src/adapter.ts` | 使用 `isAnthropicProvider()` 替代内联字符串比较 |
| `packages/shared/src/bootstrap/common-specs.ts` | 默认值通过常量引用；去掉 `anthropic-compatible` 选项 |
