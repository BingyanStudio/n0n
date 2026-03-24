# 008 — @n0n/types 包含运行时代码 StreamAccumulator

**严重度**: 🟢 低（违背架构约定）
**文件**: `packages/types/src/client.ts`

## 问题描述

plan 文档明确声明 `@n0n/types` 的定位是：

> ※ 纯类型，零运行时依赖

但 `client.ts` 中的 `StreamAccumulator` 是一个完整的 class，包含：
- 状态字段（`content`、`reasoning`、`toolCalls` Map 等）
- `push()` 方法（运行时逻辑：事件累积）
- `toMessage()` 方法（数据转换）

```ts
export class StreamAccumulator {
    content = "";
    reasoning = "";
    // ...
    push(event: StreamEvent): void { /* ~30行运行时逻辑 */ }
    toMessage(): AssistantMessage { /* 数据转换 */ }
}
```

## 违背原则

**架构约定违背**：types 包不应包含运行时逻辑。StreamAccumulator 被 `@n0n/core`（agent loop）和 `@n0n/tools`（editor-loop）使用，如果放在 types 中，使得 types 从"纯类型层"变成了"类型 + 工具类"层。

## 建议

将 `StreamAccumulator` 移到 `@n0n/shared` 或 `@n0n/core` 中。types 只保留 `AssistantMessage` 和 `AssistantToolCallPart` 类型定义。
