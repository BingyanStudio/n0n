# 009 — OpenAI Client 中 flush 残余 buffer 逻辑与主循环重复

**严重度**: 🟢 低（违背 SSOT / DRY）
**文件**: `packages/llm/src/openai-client.ts`

## 问题描述

`stream()` 方法中有两套几乎相同的 SSE chunk 处理逻辑：

1. **主循环**（~L210-260）：正常解析 `data:` 行，处理 usage、delta、finish_reason
2. **flush 残余 buffer**（~L262-300）：流结束后处理 buffer 中残余数据，逻辑与主循环几乎完全相同

```ts
// 主循环中：
if (delta.reasoning_content) yield { type: "thinking", text: delta.reasoning_content };
if (delta.content) yield { type: "content", text: delta.content };
if (delta.tool_calls) { for (const tc of delta.tool_calls) yield { ... }; }

// flush 中（完全重复）：
if (delta.reasoning_content) yield { type: "thinking", text: delta.reasoning_content };
if (delta.content) yield { type: "content", text: delta.content };
if (delta.tool_calls) { for (const tc of delta.tool_calls) yield { ... }; }
```

Anthropic Client 也存在类似问题，但程度较轻（flush 只处理 message_delta）。

## 违背原则

**DRY 违背**：相同的 chunk → StreamEvent 映射逻辑出现两次。如果新增一个 delta 字段处理，需要同时修改两处。

## 建议

提取一个 `processSSEChunk(chunk: SSEChunk): StreamEvent[]` 内部函数，主循环和 flush 共用。或者更彻底地，使用 001 中建议的通用 SSE 解析器，从根本上消除 flush 路径。
