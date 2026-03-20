# Thinking 链路 — 最终分析与结论

## 核心发现

### Responses API 不可行（推翻上一轮结论）

| 问题 | 详情 |
|------|------|
| tool-result 回传 | 需要 `store=true` + `itemId`，否则 tool result 不发送给 API |
| 多轮 tool calling | 代理网关下报错 `toolConfig field must be defined` |
| reasoning 回传 | 需要 `encryptedContent`，非 OpenAI 官方服务下被丢弃 |
| 上下文管理 | 有状态会话 API，设计用于服务端管理历史，与我们自行累积上下文的架构冲突 |

**Responses API 是 OpenAI 的有状态会话 API，与我们无状态拼接 messages 的架构根本不兼容。**

### Chat Completions 的 reasoning_content 无法解决

AI SDK `@ai-sdk/openai` 的 Chat Completions SSE 解析器只处理 `delta.content` 和 `delta.tool_calls`，
**在解析层面就丢弃了 `reasoning_content`**。fetch 层拦截也无法恢复——数据到达 AI SDK 解析器时已经丢失。

### 真正的解决方案

**网关 `your-ai-gateway.example.com` 实际上支持 Anthropic Messages API！**

端点路径是 `/v1/messages`（不是 `/messages`），实测确认：
- ✅ Anthropic Messages 协议完整支持
- ✅ thinking/reasoning 流式输出（thinking_delta 事件）
- ✅ tool calling 正常
- ✅ prompt caching token 统计正常

只需配置 `@ai-sdk/anthropic` 的 `baseURL` 为 `https://your-ai-gateway.example.com/v1`，
AI SDK 会拼接为 `{baseURL}/messages` → `https://your-ai-gateway.example.com/v1/messages`。

## 用户配置修改

```env
LLM_PROVIDER=anthropic
LLM_BASE_URL=https://your-ai-gateway.example.com/v1
LLM_ENABLE_THINKING=true
```

无需修改任何代码。`refactor/thinking-review-fixes` 分支已支持 `anthropic` + `baseUrl` 配置。

## 教训

1. **Responses API ≠ Chat Completions API 的简单替代**。它是有状态会话 API，tool-result 回传、reasoning 回传都有额外要求（store/itemId/encryptedContent）。
2. **在假设网关不支持某协议之前，先全面探测端点**。网关支持 `/v1/messages` 但不支持 `/messages`，一个路径差异导致了大量绕道。
3. **AI SDK 的价值在于 provider-specific 协议层**（Anthropic 的 thinking_delta、prompt caching），不在于 openai-compatible 路径。openai-compatible 本质上是"最低公约数"，高级特性必然丢失。
