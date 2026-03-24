# 004 — finishReason 字符串散落多处，缺少 SSOT 常量

**严重度**: 🟡 中（违背 SSOT）
**文件**: `packages/core/src/agent/loop.ts`, `packages/llm/src/anthropic-client.ts`

## 问题描述

`finishReason` 在多处以魔法字符串出现，且 OpenAI 和 Anthropic 使用不同的原生值：

### agent/loop.ts 消费侧
```ts
if (acc.finishReason === "length") { ... }
if (acc.finishReason === "content_filter" || acc.finishReason === "content-filter") { ... }
```

注意此处同时检查了 `content_filter`（下划线）和 `content-filter`（连字符），说明消费方需要猜测上游 provider 的命名风格。

### anthropic-client.ts 生产侧
```ts
finishReason:
    stopReason === "end_turn" ? "stop"
    : stopReason === "max_tokens" ? "length"
    : stopReason === "tool_use" ? "tool_calls"
    : stopReason,
```

Anthropic Client 做了归一化（`end_turn` → `stop`，`max_tokens` → `length`），但映射表没有提取为 SSOT 常量。

## 违背原则

1. **SSOT 违背**：`finishReason` 的合法值没有统一定义。如果新增一个 provider 或新增一个 finishReason 值，需要同时修改 Client 映射和消费方检查。
2. **防御性编程负担**：`content_filter` 两种写法的检查就是典型的 SSOT 缺失导致的防御性代码。

## 建议

在 `@n0n/types/client.ts` 中定义 `FinishReason` 常量枚举：

```ts
export const FinishReason = {
    STOP: "stop",
    LENGTH: "length",
    TOOL_CALLS: "tool_calls",
    CONTENT_FILTER: "content_filter",
} as const;
```

各 Client 负责将 provider 原生值映射到此枚举，消费方只引用常量。
