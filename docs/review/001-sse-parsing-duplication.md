# 001 — SSE 解析逻辑在 OpenAI/Anthropic Client 中大量重复

**初评严重度**: 🔴 高（违背 SSOT）
**二次审查**: 🟡→🟢 **降级 — 过度工程化**
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 初评描述

两个 Client 的 `stream()` 方法中共享了底层的 SSE 分帧机制（reader 循环、`\n\n` 分帧、`data:` 行解析、buffer 管理）。初评建议提取一个通用 `parseSSEStream()` 异步生成器。

## 二次审查：为什么这是过度工程化

### 1. 两者的 SSE 语义模型完全不同

「SSE」仅仅是一个传输编码，真正的业务逻辑在于**如何解释每个 SSE 帧**。两者的差异不是细微的——它们是完全不同的协议：

| 维度 | OpenAI | Anthropic |
|------|--------|-----------|
| 帧结构 | `data: {json}\n\n` | `event: {type}\ndata: {json}\n\n` |
| 事件区分 | JSON 内部 `choices[0].delta` 字段 | `event:` 行 + JSON `type` 字段 |
| 终止标记 | `data: [DONE]` 魔法字符串 | `message_stop` 事件类型 |
| 完成原因 | `choices[0].finish_reason` | `message_delta.delta.stop_reason`（需归一化） |
| 工具调用 | `delta.tool_calls[].index` 增量拼接 | `content_block_start(tool_use)` + `input_json_delta` 两阶段 |
| 用量统计 | 单次 `usage` chunk | `message_start.usage`(input) + `message_delta.usage`(output) 两阶段 |
| 状态管理 | 无额外状态 | `toolBlocks` Map（SSE index → sequential index） |

### 2. 真正共享的只是 ~10 行样板代码

去掉语义差异后，真正重复的只有：

```ts
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        // ... 此处开始完全不同 ...
        boundary = buffer.indexOf("\n\n");
    }
}
```

这 ~10 行是「ReadableStream + `\n\n` 分帧」的标准模式，就像两个函数都有 `for` 循环一样——它是语言级别的惯用法，不是业务逻辑重复。

### 3. 提取的代价大于收益

如果提取一个 `parseSSEStream()` 生成器，它需要：
- 泛型返回类型（OpenAI 返回 `{data: string}`，Anthropic 返回 `{event: string, data: string}`）
- 调用方仍然需要解析 JSON、类型断言、状态管理
- 增加了一层间接——调试 SSE 问题时需要跳入跳出

而收益是什么？省去了 ~10 行完全可以理解的样板代码。不值得。

### 4. 真正应该修的是 009（同函数内的 DRY）

初评把 009（OpenAI 内 flush 逻辑与主循环重复）和 001 混为一谈了。009 才是真正的 DRY 问题——**同一个函数内、同一个语义上下文中**的复制粘贴。这个应该修（提取 `processChunk` 内部函数），而跨 Client 的 SSE 分帧不应该提取。

## 结论

**不建议行动**。两个 Client 的 SSE 解析在传输层的相似性是巧合（都用了 SSE 协议），而非语义重复。强行提取会增加间接层、降低可读性，且几乎不降低维护成本（修改 SSE 解析时，99% 的修改是在语义映射层，不在分帧层）。
