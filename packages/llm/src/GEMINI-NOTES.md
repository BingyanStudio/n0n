# Gemini Client 实现笔记

## 缓存机制

Gemini 有两种缓存。当前实现依赖隐式缓存，无需代码改动。

### 隐式缓存（自动启用）

Gemini 2.5+ / 3.x 默认开启，不需要传 `cache_control`。

核心行为（实测 `gemini-3.1-pro-preview`）：

- 缓存在**请求完成后**异步写入，同一请求第一次不命中，第二次起命中
- 做**前缀匹配**：上下文增长时公共前缀部分命中缓存
- **缓存不会随对话增长而扩大**——始终命中的是首次请求建立的前缀段（~4070 tokens）
- 最低阈值 4096 tokens（pro 模型），不保证命中

模拟 agent loop 的实测数据（每轮新增 ~173 tokens）：

```
Turn 1 (cold):   prompt=6510  cached=0     text=6510   ← 缓存写入
Turn 2:          prompt=6683  cached=4072  text=2611   ← 命中首次前缀
Turn 3:          prompt=6856  cached=4067  text=2789   ← 同上，缓存量不增长
Turn 4:          prompt=7029  cached=4062  text=2967
Turn 5:          prompt=7202  cached=4057  text=3145
```

### 显式缓存（通过 litellm 的 cache_control）

litellm 将 system 消息上的 `cache_control: { type: "ephemeral" }` 映射为 Gemini cachedContent 资源。**仅 system 消息有效**，非 system 消息上的断点被忽略。

```
system(cache_control) + Q1:      prompt=4701  cached=4699  text=2
system(cache_control) + history:  prompt=5132  cached=4699  text=433
```

### 与 Anthropic 的成本对比

Anthropic 的断点可以跟随对话尾部移动，每轮只为新增 token 付全价。Gemini 的隐式缓存只覆盖固定前缀。

| 轮次 | Anthropic (移动断点) | Gemini (隐式缓存) |
|------|---------------------|-------------------|
| Turn 1 | 缓存写入全部 | 缓存写入前缀 ~4070 |
| Turn 2 (+173t) | 缓存读旧 + 写新 ~173t | 缓存读 4072 + 全价 2611t |
| Turn 5 (+692t) | 缓存读旧 + 写新 ~173t | 缓存读 4057 + 全价 3145t |

**结论：Gemini 的增量成本高于 Anthropic。** 对话越长差距越大——Anthropic 每轮新增成本近似恒定，Gemini 的全价部分线性增长。

### 当前实现决策

GeminiClient 不注入 `cache_control`，完全依赖隐式缓存：
- 无需额外代码
- system prompt 超过 4096 tokens 时自动生效
- 显式缓存仅能额外覆盖 system 消息（litellm 限制），收益有限

---

## Thinking

`gemini-3.1-pro-preview` 始终内部思考，无法关闭。`reasoning_effort` 控制思考强度和输出方式。

### 配置方式

在 `.env` 中设置：

```
LLM_PROVIDER=google
LLM_ENABLE_THINKING=true
LLM_THINKING_EFFORT=high        # low / medium / high
```

优先级：`LLM_THINKING_EFFORT` > `LLM_ENABLE_THINKING`（后者 fallback 为 `reasoning_effort=high`）。

### reasoning_effort 各等级行为

| 配置 | reasoning_tokens (复杂问题) | reasoning_content 独立流式传输 |
|------|---------------------------|------------------------------|
| 不传（默认） | ~1556 | 否（混入 content） |
| `low` | ~939 | 是 |
| `medium` | ~1151 | 是 |
| `high` | ~1275 | 是 |

注意：`thinking: { type: "enabled", budget_tokens: N }` 参数也可用，但**不能与 `reasoning_effort` 同时传**（litellm 报错）。当前实现使用 `reasoning_effort`。

### SSE 事件映射

```
delta.reasoning_content                           → StreamEvent.thinking
delta.content                                     → StreamEvent.content
delta.provider_specific_fields.thought_signatures  → StreamEvent.thinking_signature
```

### 多轮回传

assistant 消息中通过 `reasoning_content` 字段传递历史思考内容（与 DeepSeek 格式一致）。

---

## 成本统计

usage 字段映射：

| TokenUsage 字段 | 来源 |
|---|---|
| `inputTokens` | `prompt_tokens - cached_tokens` |
| `outputTokens` | `completion_tokens`（含 reasoning_tokens） |
| `totalTokens` | `total_tokens` |
| `cacheReadTokens` | `prompt_tokens_details.cached_tokens` |
| `cacheWriteTokens` | 0（隐式缓存无独立写入字段） |
