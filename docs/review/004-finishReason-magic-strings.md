# 004 — finishReason 字符串散落多处，缺少 SSOT 常量

**初评严重度**: 🟡 中（违背 SSOT）
**二次审查**: 🟡 **维持 — 真正的 SSOT 问题，建议修复**
**文件**: `packages/core/src/agent/loop.ts`, `packages/llm/src/anthropic-client.ts`

## 初评描述

`finishReason` 在多处以魔法字符串出现，消费方（loop.ts）需要猜测 provider 的命名风格（`content_filter` vs `content-filter`）。

## 二次审查：确认这是真正的 SSOT 问题

### 1. 问题已在代码中可见

```ts
// loop.ts — 消费侧需要同时检查两种写法
if (acc.finishReason === "content_filter" || acc.finishReason === "content-filter")
```

这正是 SSOT 缺失的典型症状：消费方不确定上游会给什么值，只能做防御性编程。

### 2. 归一化点已经存在，只是不完整

Anthropic Client 已经做了归一化（`end_turn` → `stop`，`max_tokens` → `length`），说明设计意图是让消费方只看到统一的值。但没有一个集中定义来声明「这些就是所有合法值」。

### 3. 修复成本低，收益明确

在 `@n0n/types/client.ts` 中增加：

```ts
export const FinishReason = {
    STOP: "stop",
    LENGTH: "length",
    TOOL_CALLS: "tool_calls",
    CONTENT_FILTER: "content_filter",
} as const;
export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];
```

然后：
- Anthropic Client 的归一化映射引用此常量
- loop.ts 的检查引用此常量
- `content-filter` 的连字符写法在 Client 层归一化，消费方不再需要猜

## 结论

**建议修复**。定义 `FinishReason` 常量枚举，各 Client 归一化到枚举值，消费方只引用常量。修复成本约 30 分钟，能消除跨模块的魔法字符串。
