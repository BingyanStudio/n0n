# 008 — @n0n/types 包含运行时代码 StreamAccumulator

**初评严重度**: 🟢 低（违背架构约定）
**二次审查**: 🟢 **维持 — 架构洁癖，低优先级**
**文件**: `packages/types/src/client.ts`

## 初评描述

plan 文档声明 `@n0n/types` 是「纯类型，零运行时依赖」，但 `StreamAccumulator` 是一个包含运行时逻辑的 class。

## 二次审查

### 1. 问题客观存在

`StreamAccumulator` 包含：
- `push()` 方法（~25 行运行时逻辑）
- `toMessage()` 方法（数据转换）
- 可变状态字段

这确实违背了 types 包的「纯类型」定位。

### 2. 但实际影响很小

- `StreamAccumulator` 没有外部依赖（不 import 任何第三方库）
- 它与 `StreamEvent`、`AssistantMessage` 类型紧密相关——这些类型定义在同一个文件中
- 两个消费方（`@n0n/core` 的 agent loop 和 `@n0n/tools` 的 editor-loop）都已经依赖 `@n0n/types`

### 3. 移动的边际收益低

如果移到 `@n0n/shared`：
- `@n0n/core` 和 `@n0n/tools` 需要改 import 路径（它们已经依赖 `@n0n/shared`，所以不增加新依赖）
- types 包恢复「纯类型」定位
- 但代码组织上，`StreamAccumulator` 和 `StreamEvent` 分离到不同包，阅读时需要跳转

如果移到 `@n0n/core`：
- `@n0n/tools`（editor-loop）需要依赖 `@n0n/core`，这会破坏现有的依赖方向

最合理的目标包是 `@n0n/shared`，但收益有限。

## 结论

**可选行动，低优先级**。如果在做其他重构时顺带移动，成本不高。但不值得单独为此开 PR。
