# Review Issue #012: SSE 解析在流结束时可能丢失 buffer 残留数据

## 严重程度：低

## 位置
- `packages/llm/src/openai-client.ts` (L280-365)
- `packages/llm/src/anthropic-client.ts` (L325-460)

## 描述

两个 Client 的 SSE 解析都使用相同模式：

```ts
while (true) {
    const { done, value } = await reader.read();
    if (done) break;  // 流结束
    buffer += decoder.decode(value, { stream: true });
    // 处理 \n\n 分隔的事件...
}
```

当 `reader.read()` 返回 `done: true` 时直接 break，此时 buffer 中可能仍有未被 `\n\n` 分隔的残留数据。

**SSE 规范**规定每个事件以 `\n\n` 结尾，但在某些代理或 CDN 场景中，TCP 连接关闭可能在最后一个 `\n\n` 之前发生。如果最后的事件是 `[DONE]`（OpenAI）或 `message_stop`（Anthropic），丢失它不影响功能。但如果是 `message_delta`（含 `stop_reason`），则 `done` 事件不会被 yield，consumer 不知道流正常结束。

## 影响

在正常网络条件下极少发生。大多数 provider 会在流结束前正确发送完所有 SSE 事件。但在代理/CDN 环境下可能偶尔出现。

## 建议

在 `while(true)` 循环后，检查 buffer 是否有残留数据，尝试解析它：
```ts
// flush remaining buffer
if (buffer.trim()) {
    // 尝试解析残留数据...
}
```
