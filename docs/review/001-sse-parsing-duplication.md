# 001 — SSE 解析逻辑在 OpenAI/Anthropic Client 中大量重复

**严重度**: 🔴 高（违背 SSOT）
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 问题描述

两个 Client 的 `stream()` 方法中，SSE（Server-Sent Events）的底层解析逻辑几乎完全相同：

```ts
// 两处都有：
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
// ...
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) { /* 相同的分帧逻辑 */ }
}
// flush remaining buffer... (又一套相同逻辑)
```

两处都包含：
1. ReadableStream reader 循环
2. `\n\n` 分帧
3. `data:` / `event:` 行解析
4. buffer 清理
5. flush 残余 buffer
6. AbortError 捕获 + reader.releaseLock()

## 违背原则

**SSOT 违背**：SSE 流的分帧、buffering、cleanup 逻辑是通用基础设施，在两处实现意味着修 bug 需要改两处。

## 建议

抽取通用 SSE 解析器到独立模块（如 `sse-parser.ts`），提供一个 `parseSSEStream` 生成器函数：

```ts
async function* parseSSEStream(body: ReadableStream, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
    // 统一的分帧 + buffer 管理
}
```

各 Client 只关注语义层映射（OpenAI JSON → StreamEvent / Anthropic JSON → StreamEvent）。
