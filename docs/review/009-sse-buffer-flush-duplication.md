# 009 — OpenAI Client 中 flush 残余 buffer 逻辑与主循环重复

**初评严重度**: 🟢 低（违背 SSOT / DRY）
**二次审查**: 🟡 **升级 — 同函数内的真正 DRY 违背**
**文件**: `packages/llm/src/openai-client.ts`

## 初评描述

`stream()` 方法中有两套几乎相同的 SSE chunk 处理逻辑：主循环和 flush 残余 buffer。

## 二次审查：与 001 截然不同的问题

### 1. 这是同一个函数、同一个语义上下文内的复制粘贴

不同于 001（跨 Client 的传输层相似性），009 是 OpenAI Client 内部的同一个 `stream()` 方法中，**完全相同的 delta→StreamEvent 映射逻辑**出现了两次：

```ts
// 主循环（~L210-260）和 flush（~L262-300）中完全相同的代码：
if (delta.reasoning_content) yield { type: "thinking", text: delta.reasoning_content };
if (delta.content) yield { type: "content", text: delta.content };
if (delta.tool_calls) { for (const tc of delta.tool_calls) yield { ... }; }
```

加上 `usage` 的处理、`finish_reason` 的记录，总共约 25 行完全重复。

### 2. Anthropic Client 也有类似问题（程度较轻）

Anthropic 的 flush 块中 `message_delta` 的处理（`stop_reason` 归一化 + usage 合并）与主循环中的 `message_delta` case 完全相同（约 15 行重复）。

### 3. 修复方案简单

在 `stream()` 方法内部提取一个局部函数（闭包可访问 `lastUsage`、`lastFinishReason`）：

```ts
function* processLine(line: string): Generator<StreamEvent> {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6);
    if (payload === "[DONE]") { /* ... */ }
    // ... delta → StreamEvent 映射
}
```

主循环和 flush 共用此函数。也可以用 `processChunk` 的风格——处理一个完整的 SSE 帧。

## 结论

**建议修复**。这是同一个函数内的明确 DRY 违背。提取内部函数即可，不需要跨文件。修复成本约 15 分钟。Anthropic Client 同理，可顺带处理。
