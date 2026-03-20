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

**结论：代理提供 anthropic 兼容协议时，优先走 `@ai-sdk/anthropic`，无需自定义 fetch。**

## 修复内容

| 文件 | 改动 |
|------|------|
| `packages/llm/src/config.ts` | 新增 `AnthropicCompatibleProviderConfig`（anthropic + 自定义 baseURL） |
| `packages/llm/src/provider.ts` | `createLanguageModel` 新增 `anthropic-compatible` 分支 |
| `packages/llm/src/config-from-env.ts` | 推断逻辑 + `LLM_THINKING_BUDGET_TOKENS` |
| `packages/llm/src/stream.ts` | `StreamOptions` 增加 `providerOptions` 透传 |
| `packages/core/src/agent/loop.ts` | 构造 thinking providerOptions 传给 stream |
| `packages/llm/src/adapter.ts` | assistant 消息回传 `ReasoningPart`（交替思考） |
